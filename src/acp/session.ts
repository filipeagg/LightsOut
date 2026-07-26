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
import { spawnAdapter, type AdapterProcess } from "./adapter.js";
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
  /** Workspace root, so shared material classifies as §7.1 says rather than as an escape. */
  workspacePath?: string;
  /** The one base this project may write into, if any (KB-05). */
  writableKnowledgeBase?: string;
  /** Absolute paths of the workspace directories this project may read (PE-09). */
  readAreas?: string[];
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
  return first?.path;
}

/**
 * Collect every string that might be the command being run. Adapters disagree: Claude Code
 * puts the literal command in the tool-call title and a prose description in the content, so
 * reading only one of them lets a friendly description hide a sensitive command.
 */
function commandCandidates(update: ToolCallUpdate): string[] {
  if (update.kind !== "execute") return [];
  const candidates: string[] = [];
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

  private flushMessage(force = false): void {
    if (!this.pendingMessage.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastFlush < MESSAGE_FLUSH_MS) return;
    const lines = this.pendingMessage.trimEnd().split("\n");
    this.event("agent.message", { textExcerpt: lines[lines.length - 1]?.slice(0, 500) ?? "" });
    this.pendingMessage = "";
    this.lastFlush = now;
  }

  /** Map one ACP notification to events rows (SR-02, DESIGN §6.3). */
  private handleUpdate(notification: SessionNotification): void {
    const update = notification.update;
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
      case "tool_call": {
        const path = firstPath(update);
        this.event("tool.call", {
          kind: update.kind ?? "other",
          title: update.title ?? "",
          ...(path ? { path } : {}),
        });
        break;
      }
      case "tool_call_update": {
        if (update.status === "completed" && (update.kind === "edit" || update.kind === "delete")) {
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
    const paths = (toolCall.locations ?? [])
      .map((l) => l.path)
      .filter((p): p is string => typeof p === "string");

    const decision = this.deps.policy.evaluate({
      projectPath: this.deps.project.path,
      // Without these two the workspace-aware rules of §7.1 cannot fire and every path
      // outside the project stays `outside_workspace`, which is the safe reading.
      ...(this.deps.workspacePath ? { workspacePath: this.deps.workspacePath } : {}),
      ...(this.deps.writableKnowledgeBase
        ? { writableKnowledgeBase: this.deps.writableKnowledgeBase }
        : {}),
      // PE-09: the directories this project was allowed to read outside itself.
      ...(this.deps.readAreas?.length ? { readAreas: this.deps.readAreas } : {}),
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
    this.event("perm.verdict", {
      class: decision.class,
      verdict: decision.verdict,
      ruleSource: decision.ruleSource,
      ...(decision.learnedShape ? { learned: decision.learnedShape } : {}),
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

    const adapter = spawnAdapter({
      command: this.deps.adapterCommand,
      cwd: project.path,
      // Vault values reach the agent only here: they are excluded from every other run's
      // environment, so an agent with no network grant cannot see them at all (§18).
      ...(this.deps.vaultEnv && Object.keys(this.deps.vaultEnv).length > 0
        ? { env: this.deps.vaultEnv }
        : {}),
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
