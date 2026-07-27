/**
 * Run lifecycle over ACP (SR-01..07, PE-04, DESIGN §6).
 *
 * One RunSession drives one adapter process through one prompt turn: it normalizes ACP
 * notifications into `events` rows, mediates every permission request through the policy
 * engine, arms the two watchdogs, captures usage, and resolves the LIGHTSOUT_RESULT sentinel.
 * It owns no orchestration: chains, git and doubts are phases 4 and 5.
 */
import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";
import type { Repos } from "../db/repos/index.js";
import type { Bus } from "../bus.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { Verdict } from "../policy/schema.js";
import type { ProjectRow, RunRow, TaskRow } from "../db/types.js";
import type { AgentProfile } from "../agents/schema.js";
import path from "node:path";
import { spawnAdapter, type AdapterProcess } from "./adapter.js";
import { SCRATCH_REL } from "../policy/classify.js";
import { toolchainEnv } from "../projects/toolchain.js";
import { parseResult, type AgentResult, type DoubtPayload } from "./result.js";
import { composePrompt, readDocContext } from "./prompt.js";

export type SessionLimits = {
  /** Hard timeout in minutes (SR-04). */
  timeoutMin: number;
  /** Inactivity timeout in minutes (SR-04). */
  inactivityMin: number;
};

/** How a require_human verdict is resolved. Phase 5 plugs the doubt flow in here. */
export type HumanGate = (request: {
  runId: string;
  actionClass: string;
  title: string;
  reason: string;
  options: PermissionOption[];
  /** The paths the request named, when it named any: the judge needs them (PE-11). */
  paths?: string[];
  /**
   * PE-13: a `credentials` gate whose whole evidence was this run's own vault entry. Still
   * `require_human`, but the judge is allowed to look at it (§7.1d).
   */
  judgeEligible?: boolean;
}) => Promise<{ optionId: string } | { reject: true; explanation: string }>;

export type RunSessionDeps = {
  repos: Repos;
  bus: Bus;
  policy: PolicyEngine;
  project: ProjectRow;
  task: TaskRow;
  run: RunRow;
  profile: AgentProfile;
  instructions: string;
  adapterCommand: string;
  limits: SessionLimits;
  /** Settled decisions prepended to the prompt when a task is re-run (DESIGN §8.2). */
  decisionContext?: string;
  /** "Compact your deliverable first" when the existing one fails the format check (BA-08). */
  formatFeedback?: string;
  /** Curated knowledge for this run, already budgeted (KB-04). */
  knowledgeBlock?: string;
  /** The vault index for the prompt, and the variables the adapter process gets (VT-02). */
  vaultIndex?: string;
  vaultEnv?: Record<string, string>;
  /**
   * Hosts the resolved vault entries declare (PE-13, §7.1d). A vault value on its way to one of
   * them is the run doing its job; on its way anywhere else it stays on the hard floor.
   */
  vaultHosts?: string[];
  /** OR-12: this project's runs finish without a person (§7.7). */
  unattended?: boolean;
  /** Workspace root, so shared material classifies as §7.1 says rather than as an escape. */
  workspacePath?: string;
  /** The one base this project may write into, if any (KB-05). */
  writableKnowledgeBase?: string;
  /** Absolute paths of the workspace directories this project may read (PE-09). */
  readAreas?: string[];
  /** The subset of those it may also write to (PE-09 amended, §9.5). */
  writeAreas?: string[];
  /** Defaults to rejecting with an explanation, which is honest for phase 3. */
  humanGate?: HumanGate;
  onStderr?: (line: string) => void;
};

export type RunOutcome = {
  status: "ok" | "doubt" | "timeout" | "stuck" | "error" | "aborted";
  summary: string;
  doubt?: DoubtPayload;
  exitReason: string;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | undefined;
  acpSession?: string | undefined;
  sentinelMissing: boolean;
  /** The run died because the engine's credentials are gone or expired (§11.3). */
  authRequired?: boolean;
};

const MESSAGE_FLUSH_MS = 2000;
/** Below this a chunk is a fragment, not a sentence; it waits for the next one (OB-06). */
const MESSAGE_MIN_CHARS = 40;
const CANCEL_GRACE_MS = 10_000;

/**
 * Recognise an authentication failure in whatever shape the adapter passed it through (§11.3).
 * Both CLIs surface the provider's own words, so this matches on the words rather than a code:
 * a 401, an expired OAuth token, or a plain "not logged in".
 */
const AUTH_PATTERNS = [
  /\b401\b/,
  /oauth[^.]*token[^.]*(expired|invalid|revoked)/i,
  /failed to authenticate/i,
  /authentication[_ -]?(error|failed|required)/i,
  /\bunauthorized\b/i,
  /not logged in/i,
  /invalid[_ -]api[_ -]key/i,
  /re-?authenticate/i,
];

export function isAuthFailure(message: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(message));
}

/** Pick the option whose kind matches the verdict; adapters name them differently. */
function chooseOption(
  options: PermissionOption[],
  want: "allow" | "reject",
): PermissionOption | undefined {
  const wanted: PermissionOptionKind[] =
    want === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

function firstPath(update: ToolCallUpdate): string | undefined {
  const locations = update.locations ?? [];
  const first = locations[0];
  if (first?.path) return first.path;
  // Same reason as the command above: a read whose location the adapter did not fill in still
  // names its file in the tool's own parameters, and "reads a file" helps nobody (OB-06).
  const raw = (update as { rawInput?: unknown }).rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["file_path", "path", "filePath", "notebook_path"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/**
 * Every path a tool call means to touch, however the adapter chose to say so (§7.1e).
 *
 * The bug this exists for: `contract-prober` on Codex could not write a single file. Codex asks
 * to write through `apply_patch`, whose ACP request carries **no `locations`** and an empty
 * title, so the classifier saw a `project_write` naming no path at all — and a pack that confines
 * writes must refuse a write whose target it cannot see. Every write from that engine was denied,
 * which reads as "the policy hates me" and is really "the policy is blind".
 *
 * `firstPath` already knew to look in `rawInput` for the narration (OB-06). The classifier did
 * not, and a timeline that can name the file while the gate cannot is the same bug seen twice.
 */
export function pathCandidates(update: ToolCallUpdate): string[] {
  const paths = (update.locations ?? [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);

  const raw = (update as { rawInput?: unknown }).rawInput;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["file_path", "path", "filePath", "notebook_path", "target", "dest"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
    // A list of edits: `changes: [{path: …}]`, `files: ["…"]`.
    for (const key of ["changes", "files", "paths", "edits"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) paths.push(item.trim());
          else if (item && typeof item === "object") {
            const nested = (item as Record<string, unknown>).path;
            if (typeof nested === "string" && nested.trim()) paths.push(nested.trim());
          }
        }
      } else if (value && typeof value === "object") {
        // `changes: { "probes/x.py": {...} }` — the keys are the paths.
        for (const key2 of Object.keys(value as Record<string, unknown>)) {
          if (key2.trim()) paths.push(key2.trim());
        }
      }
    }
    // The patch envelope itself: `*** Add File: probes/probe.py`.
    for (const key of ["input", "patch", "content", "diff"]) {
      const value = record[key];
      if (typeof value === "string") paths.push(...pathsInPatch(value));
    }
  }

  // ACP carries an edit as a `diff` content entry — `{type:"diff", path, oldText, newText}` —
  // and that is where Codex puts it: no locations, no title, no rawInput. Reading only the
  // first three left every one of its writes a `project_write` naming nothing, which a confined
  // pack must refuse. The type is not pinned down by the schema, so this reads any content entry
  // that names a path rather than matching on `type`.
  for (const item of update.content ?? []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    for (const key of ["path", "newPath", "oldPath", "file", "filePath"]) {
      const value = entry[key];
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
    const nested = entry["content"];
    if (nested && typeof nested === "object") {
      const value = (nested as Record<string, unknown>)["path"];
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
    for (const key of ["newText", "diff", "patch"]) {
      const value = entry[key];
      if (typeof value === "string") paths.push(...pathsInPatch(value));
    }
  }
  return [...new Set(paths)];
}

/**
 * The shape of what an adapter sent, for the audit row — keys and content types, never values.
 *
 * Engines disagree about where they put things and the ACP schema does not pin it down, so when a
 * request arrives that the classifier cannot read, the only way to find out why is to have
 * recorded what arrived. Twice now that has been reconstructed by hand from a running container.
 */
export function adapterShape(update: ToolCallUpdate): Record<string, unknown> {
  const raw = (update as { rawInput?: unknown }).rawInput;
  return {
    keys: Object.keys(update as Record<string, unknown>).sort(),
    contentTypes: (update.content ?? []).map(
      (item) => (item as { type?: string }).type ?? "unknown",
    ),
    contentKeys: [
      ...new Set(
        (update.content ?? []).flatMap((item) =>
          item && typeof item === "object" ? Object.keys(item as Record<string, unknown>) : [],
        ),
      ),
    ].sort(),
    rawInputKeys:
      raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>).sort() : null,
    locations: (update.locations ?? []).length,
  };
}

/** Paths named by an apply_patch envelope or a unified diff header. */
export function pathsInPatch(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(
    /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gim,
  )) {
    if (match[1]) paths.push(match[1]);
  }
  for (const match of text.matchAll(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)\s*$/gim)) {
    const candidate = match[1];
    if (candidate && candidate !== "/dev/null") paths.push(candidate);
  }
  return paths;
}

/**
 * Collect every string that might be the command being run. Adapters disagree: Claude Code
 * puts the literal command in the tool-call title and a prose description in the content, so
 * reading only one of them lets a friendly description hide a sensitive command.
 */
function commandCandidates(update: ToolCallUpdate): string[] {
  if (update.kind !== "execute") return [];
  const candidates: string[] = [];
  // The tool's own parameters, when the adapter passes them through: this is where Claude Code
  // puts the actual command, while `title` is often just "Terminal". Read first, because it is
  // the literal thing that will run — and because a timeline saying "Terminal" twenty times, and
  // a classifier judging by a friendly title, are the same bug seen from two sides.
  const raw = (update as { rawInput?: unknown }).rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["command", "cmd", "script"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) candidates.push(value.trim());
    }
  }
  if (typeof update.title === "string" && update.title.trim()) {
    candidates.push(update.title.trim());
  }
  for (const item of update.content ?? []) {
    const candidate = item as { type?: string; text?: string; content?: { text?: string } };
    const text = candidate.text ?? candidate.content?.text;
    if (typeof text === "string" && text.trim()) candidates.push(text.trim());
  }
  return candidates;
}

export class RunSession {
  private adapter: AdapterProcess | undefined;
  private acpSessionId: string | undefined;
  private cancelSession: (() => Promise<void>) | undefined;

  private finalMessage = "";
  private pendingMessage = "";
  private lastFlush = 0;
  private pendingThought = "";
  private lastThoughtFlush = 0;
  /** Tool calls already written to the timeline, by id (OB-06). */
  private readonly emittedCalls = new Set<string>();

  private hardTimer: NodeJS.Timeout | undefined;
  private inactivityTimer: NodeJS.Timeout | undefined;
  private watchdogsPaused = false;
  private expiry: "timeout" | "stuck" | undefined;
  private aborted = false;

  private tokensIn: number | undefined;
  private tokensOut: number | undefined;
  private costUsd: number | undefined;

  constructor(private readonly deps: RunSessionDeps) {}

  private event(type: string, payload: unknown): void {
    this.deps.repos.events.append({ runId: this.deps.run.id, type, payload });
    this.deps.bus.emit("run", { runId: this.deps.run.id });
    if (!this.watchdogsPaused) this.armInactivity();
  }

  private armInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(
      () => void this.expire("stuck"),
      this.deps.limits.inactivityMin * 60_000,
    );
    this.inactivityTimer.unref?.();
  }

  private armHardTimeout(): void {
    this.hardTimer = setTimeout(
      () => void this.expire("timeout"),
      this.deps.limits.timeoutMin * 60_000,
    );
    this.hardTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.hardTimer) clearTimeout(this.hardTimer);
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
  }

  /** Watchdogs stop while a permission waits on a human: the session is idle by design. */
  private pauseWatchdogs(): void {
    this.watchdogsPaused = true;
    this.clearTimers();
  }

  private resumeWatchdogs(): void {
    this.watchdogsPaused = false;
    this.armHardTimeout();
    this.armInactivity();
  }

  /** Timeout or inactivity expiry: cancel the turn, then stop the adapter (SR-04). */
  private async expire(kind: "timeout" | "stuck"): Promise<void> {
    if (this.expiry) return;
    this.expiry = kind;
    this.clearTimers();
    this.event("system", { reason: kind, acpSession: this.acpSessionId });
    await this.cancelSession?.();
    await this.adapter?.stop(CANCEL_GRACE_MS);
  }

  /** External cancel (SR-06). */
  async abort(): Promise<void> {
    this.aborted = true;
    this.clearTimers();
    this.event("system", { reason: "aborted", acpSession: this.acpSessionId });
    await this.cancelSession?.();
    await this.adapter?.stop(CANCEL_GRACE_MS);
  }

  /**
   * One line per tool call, emitted when it is worth reading (OB-06).
   *
   * Claude Code announces a call twice: first a stub — `{title:"Terminal", rawInput:{}}` — and
   * then an update carrying the real title and `rawInput.command`. Emitting on the first gives a
   * timeline of twenty "Terminal"s, which is what the user was looking at. So the stub is held,
   * the update fills it in, and each call produces exactly one event: the informative one when
   * there is one, the stub when the call ends without ever saying more.
   */
  private recordToolCall(update: ToolCallUpdate & { sessionUpdate?: string }): void {
    const id = update.toolCallId ?? `anon-${this.emittedCalls.size}`;
    if (this.emittedCalls.has(id)) return;

    const path = firstPath(update);
    const detail = commandCandidates(update).find(
      (candidate) => candidate.trim() && candidate.trim() !== "Terminal",
    );
    const informative = Boolean(path || detail);
    const finished = update.status === "completed" || update.status === "failed";
    if (!informative && !finished) return; // the stub: wait for the update that says something

    this.emittedCalls.add(id);
    // Keep the set from growing without bound on a long turn; ids are only needed while the call
    // is in flight, and a few hundred is far more than any turn has open at once.
    if (this.emittedCalls.size > 500) this.emittedCalls.clear();
    this.event("tool.call", {
      kind: update.kind ?? "other",
      title: update.title ?? "",
      ...(path ? { path } : {}),
      ...(detail && detail !== update.title ? { detail: detail.slice(0, 300) } : {}),
    });
  }

  /** Same throttle as a message, on the thinking stream: the last line, at most every 2 s. */
  private flushThought(force = false): void {
    if (!this.pendingThought.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastThoughtFlush < MESSAGE_FLUSH_MS) return;
    const excerpt = this.pendingThought.replace(/\s+/g, " ").trim();
    this.event("agent.thought", { textExcerpt: excerpt.slice(0, 300) });
    this.pendingThought = "";
    this.lastThoughtFlush = now;
  }

  private flushMessage(force = false): void {
    if (!this.pendingMessage.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastFlush < MESSAGE_FLUSH_MS) return;
    // A first chunk is often one word ("I"), and a timeline line reading `says: I` is noise.
    if (!force && this.pendingMessage.trim().length < MESSAGE_MIN_CHARS) return;
    // The whole chunk on one line, not its last line: mid-stream, the last line is usually a
    // fragment ("| (+2 more)") and a timeline of fragments is worse than no timeline (OB-06).
    const excerpt = this.pendingMessage.replace(/\s+/g, " ").trim();
    this.event("agent.message", { textExcerpt: excerpt.slice(0, 500) });
    this.pendingMessage = "";
    this.lastFlush = now;
  }

  /** Map one ACP notification to events rows (SR-02, DESIGN §6.3). */
  private handleUpdate(notification: SessionNotification): void {
    const update = notification.update;
    // Adapters disagree about where they put a command and a path, and the only way to find out
    // is to look. `LO_DEBUG_ACP=1` records the raw tool notifications, truncated, so a timeline
    // that says "Terminal" can be diagnosed instead of guessed at. Off by default: it is noisy.
    if (
      process.env.LO_DEBUG_ACP === "1" &&
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
    ) {
      this.deps.repos.events.append({
        runId: this.deps.run.id,
        type: "system",
        payload: { reason: "acp.raw", update: JSON.stringify(update).slice(0, 900) },
      });
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content;
        if (content.type === "text") {
          this.finalMessage += content.text;
          this.pendingMessage += content.text;
          this.flushMessage();
        }
        break;
      }
      case "agent_thought_chunk": {
        // What the agent is working out, not what it did (OB-05). Throttled like a message and
        // kept short: it is the line that answers "what is it doing right now".
        const content = (update as { content?: { type?: string; text?: string } }).content;
        if (content?.type === "text" && content.text?.trim()) {
          this.pendingThought += content.text;
          this.flushThought();
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.recordToolCall(update);
        if (
          update.sessionUpdate === "tool_call_update" &&
          update.status === "completed" &&
          (update.kind === "edit" || update.kind === "delete")
        ) {
          const path = firstPath(update);
          this.event("file.edit", {
            path: path ?? "",
            op: update.kind === "delete" ? "delete" : "write",
          });
        }
        break;
      }
      case "usage_update": {
        const usage = (update as { usage?: Usage }).usage;
        if (usage) {
          this.tokensIn = usage.inputTokens;
          this.tokensOut = usage.outputTokens;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Permission mediation (SR-03, PE-04, DESIGN §6.5). */
  private async mediate(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolCall = params.toolCall;
    const commands = commandCandidates(toolCall);
    const command = commands[0];
    // Every way an adapter can name what it is about to touch (§7.1e). Reading only `locations`
    // made every Codex `apply_patch` a write with no visible target, which a confined pack has
    // no choice but to deny.
    const paths = pathCandidates(toolCall);

    const decision = this.deps.policy.evaluate({
      projectPath: this.deps.project.path,
      // ST-07: so an install into this project's own toolchain is told apart from one that
      // changes the image for everything.
      projectId: this.deps.project.id,
      // Without these two the workspace-aware rules of §7.1 cannot fire and every path
      // outside the project stays `outside_workspace`, which is the safe reading.
      ...(this.deps.workspacePath ? { workspacePath: this.deps.workspacePath } : {}),
      ...(this.deps.writableKnowledgeBase
        ? { writableKnowledgeBase: this.deps.writableKnowledgeBase }
        : {}),
      // PE-09: the directories this project was allowed to read outside itself.
      ...(this.deps.readAreas?.length ? { readAreas: this.deps.readAreas } : {}),
      ...(this.deps.writeAreas?.length ? { writeAreas: this.deps.writeAreas } : {}),
      // PE-13: which secrets are this run's own, so a command handling them is told apart from
      // one handling somebody else's. The names only — a value never reaches the classifier.
      ...(this.deps.vaultEnv ? { vaultVars: Object.keys(this.deps.vaultEnv) } : {}),
      ...(this.deps.vaultHosts?.length ? { vaultHosts: this.deps.vaultHosts } : {}),
      ...(toolCall.kind ? { kind: toolCall.kind } : {}),
      ...(toolCall.title ? { title: toolCall.title } : {}),
      ...(paths.length ? { paths } : {}),
      ...(commands.length ? { commands } : {}),
    });

    this.event("perm.request", {
      class: decision.class,
      title: toolCall.title ?? "",
      ...(command ? { command } : {}),
    });
    this.deps.repos.audit.record({
      runId: this.deps.run.id,
      actionClass: decision.class,
      detail: {
        title: toolCall.title ?? null,
        kind: toolCall.kind ?? null,
        paths,
        command: command ?? null,
        reason: decision.reason,
        // What the adapter actually sent, in shape only (§7.1e). A write denied for naming no
        // path is indistinguishable, in the timeline, from a write denied on its merits — and
        // twice now that ambiguity has cost hours. Keys and content types, never values.
        adapter: adapterShape(toolCall),
      },
      ruleSource: decision.ruleSource,
      verdict: decision.verdict,
      latencyMs: decision.latencyMs,
    });
    // PE-10: a remembered allow is used, and its counter says so — an unused rule is easy to spot
    // and revoke, and a much-used one is a matcher somebody should write.
    if (decision.learnedShape) {
      this.deps.repos.learned.recordUse(decision.learnedShape);
    }
    // ST-07: same reasoning for a toolchain authorisation — a grant nobody uses should be easy
    // to find and withdraw.
    if (decision.toolchainManager) {
      this.deps.repos.toolchainGrants.recordUse(
        this.deps.project.id,
        decision.toolchainManager,
      );
    }
    this.event("perm.verdict", {
      class: decision.class,
      verdict: decision.verdict,
      ruleSource: decision.ruleSource,
      ...(decision.learnedShape ? { learned: decision.learnedShape } : {}),
      ...(decision.toolchainManager ? { toolchain: decision.toolchainManager } : {}),
    });

    const respond = (want: "allow" | "reject"): RequestPermissionResponse => {
      const option = chooseOption(params.options, want);
      if (!option) {
        // No matching option offered: cancelling is the only honest answer.
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    };

    const verdict: Verdict = decision.verdict;
    if (verdict === "allow") return respond("allow");
    if (verdict === "provisional") {
      // PE-06: allowed and recorded; the git checkpoint tag lands in phase 4.
      this.deps.repos.decisions.record({
        projectId: this.deps.project.id,
        taskId: this.deps.task.id,
        kind: "provisional",
        question: `${decision.class}: ${toolCall.title ?? command ?? "action"}`,
        choice: "allowed provisionally",
        rationale: decision.reason,
      });
      return respond("allow");
    }
    if (verdict === "deny") return respond("reject");

    // require_human: hold the response (DESIGN §6.5). The gate decides how.
    this.pauseWatchdogs();
    this.deps.repos.runs.setStatus(this.deps.run.id, "waiting_human", "permission gate");
    this.event("run.state", { status: "waiting_human", reason: decision.class });
    try {
      const gate =
        this.deps.humanGate ??
        (async () => ({
          reject: true as const,
          explanation:
            "This action needs a human decision and no one can answer right now. " +
            "Adapt or finish with a doubt explaining what you need.",
        }));
      const answer = await gate({
        runId: this.deps.run.id,
        actionClass: decision.class,
        title: toolCall.title ?? command ?? "action",
        reason: decision.reason,
        options: params.options,
        ...(paths.length ? { paths } : {}),
        ...(decision.judgeEligible ? { judgeEligible: true } : {}),
      });
      if ("optionId" in answer) {
        return { outcome: { outcome: "selected", optionId: answer.optionId } };
      }
      this.event("system", { reason: "permission rejected", detail: answer.explanation });
      return respond("reject");
    } finally {
      this.deps.repos.runs.setStatus(this.deps.run.id, "running");
      this.event("run.state", { status: "running" });
      this.resumeWatchdogs();
    }
  }

  /**
   * The ACP session id, once the adapter has given us one. Exposed so a caller that has to
   * synthesize an outcome after a failure can still record where the work was, which is what
   * makes a resume possible (RT-07).
   */
  get acpSession(): string | undefined {
    return this.acpSessionId;
  }

  async start(): Promise<RunOutcome> {
    const { repos, project, task, run, profile } = this.deps;

    const docs = await readDocContext(project.path);
    const prompt = composePrompt(
      {
        instructions: this.deps.instructions,
        projectPath: project.path,
        taskTitle: task.title,
        taskSpec: task.spec,
        verifyCmd: task.verify_cmd ?? project.verify_cmd,
        projectContext: project.context,
        readAreas: this.deps.readAreas,
        decisionContext: this.deps.decisionContext,
        formatFeedback: this.deps.formatFeedback,
        knowledgeBase: this.deps.knowledgeBlock,
        vaultIndex: this.deps.vaultIndex,
      },
      docs,
    );

    this.event("run.state", { status: "running" });
    this.armHardTimeout();
    this.armInactivity();

    // Anything installed into the scratch directory is importable without the agent having to
    // work out how (ST-03b): `pip install --target .lightsout/tmp/deps X` then `import X`.
    // ST-07: and anything installed into the project's durable toolchain is on PATH and on the
    // language search paths for every later run. A toolchain the agent has to be told how to
    // reach is a toolchain it will not use.
    const runEnv: Record<string, string> = {
      PYTHONPATH: `${path.join(project.path, SCRATCH_REL, "deps")}:${process.env.PYTHONPATH ?? ""}`
        .replace(/:$/, ""),
      ...toolchainEnv(project.id, {
        PATH: process.env.PATH,
        PYTHONPATH: `${path.join(project.path, SCRATCH_REL, "deps")}:${process.env.PYTHONPATH ?? ""}`.replace(
          /:$/,
          "",
        ),
      }),
      ...(this.deps.vaultEnv ?? {}),
    };
    const adapter = spawnAdapter({
      command: this.deps.adapterCommand,
      cwd: project.path,
      // Vault values reach the agent only here: they are excluded from every other run's
      // environment, so an agent with no network grant cannot see them at all (§18).
      env: runEnv,
      ...(this.deps.onStderr ? { onStderr: this.deps.onStderr } : {}),
    });
    this.adapter = adapter;

    let stopReason: StopReason | "error" = "error";
    let failure: string | undefined;

    try {
      const promptResponse = await acp
        .client({ name: "lightsout" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.mediate(ctx.params))
        .connectWith(adapter.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            // No client fs or terminal capabilities: the engine uses its own tooling, so
            // every sensitive action arrives as a permission request we can mediate (SR-03).
            clientCapabilities: {},
          });

          return ctx.buildSession(project.path).withSession(async (session) => {
            this.acpSessionId = session.sessionId;
            this.cancelSession = async () => {
              await ctx.notify(acp.methods.agent.session.cancel, {
                sessionId: session.sessionId,
              });
            };
            repos.runs.setAcpSession(run.id, session.sessionId);

            void session.prompt(prompt).catch((err: unknown) => {
              failure = err instanceof Error ? err.message : String(err);
            });

            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return message.response;
              this.handleUpdate(message.notification);
            }
          });
        });

      stopReason = promptResponse.stopReason;
      const usage = promptResponse.usage;
      if (usage) {
        this.tokensIn = usage.inputTokens;
        this.tokensOut = usage.outputTokens;
      }
      // cost_usd stays NULL unless the adapter reports money; never estimated (SR-05).
      const meta = promptResponse._meta as { costUsd?: number } | null | undefined;
      if (typeof meta?.costUsd === "number") this.costUsd = meta.costUsd;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.clearTimers();
      this.flushMessage(true);
      await adapter.stop(CANCEL_GRACE_MS);
    }

    if (profile.engine === "codex") {
      // Codex reports tokens only, no cost (mirrored from the current system's experience).
      this.costUsd = undefined;
    }

    const base = {
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costUsd: this.costUsd,
      acpSession: this.acpSessionId,
    };

    if (this.expiry) {
      return {
        status: this.expiry,
        summary: "",
        exitReason:
          this.expiry === "timeout"
            ? `hard timeout after ${this.deps.limits.timeoutMin} min`
            : `no activity for ${this.deps.limits.inactivityMin} min`,
        sentinelMissing: true,
        ...base,
      };
    }
    if (this.aborted || stopReason === "cancelled") {
      return {
        status: "aborted",
        summary: "",
        exitReason: "cancelled",
        sentinelMissing: true,
        ...base,
      };
    }
    if (failure) {
      // Expired or missing credentials are not a task failure: nothing the agent did caused
      // them and retrying the task will not fix them. Tagging the reason is what lets the
      // panel's attention strip and the health tool say "reconnect the engine" (§11.3, OB-03).
      const auth = isAuthFailure(failure);
      return {
        status: "error",
        summary: "",
        exitReason: auth ? `AUTH_REQUIRED: ${failure.slice(0, 260)}` : failure.slice(0, 300),
        authRequired: auth,
        sentinelMissing: true,
        ...base,
      };
    }

    const parsed = parseResult(this.finalMessage);
    if (!parsed.ok) {
      // Missing sentinel is a warning, not a failure (DESIGN §6.4).
      this.event("system", { reason: "sentinel missing", detail: parsed.error });
      return {
        status: "ok",
        summary: parsed.fallbackSummary,
        exitReason: `finished (${stopReason}), sentinel missing`,
        sentinelMissing: true,
        ...base,
      };
    }

    const result: AgentResult = parsed.result;
    const outcome: RunOutcome = {
      status: result.status,
      summary: result.summary,
      exitReason: `finished (${stopReason})`,
      sentinelMissing: false,
      ...base,
    };
    if (result.doubt) outcome.doubt = result.doubt;
    return outcome;
  }
}
