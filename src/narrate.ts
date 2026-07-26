/**
 * Events as a person reads them (OB-05, DESIGN §12.4).
 *
 * The timeline was twenty rows of `tool.call {"kind":"execute","title":"Terminal"}`, which says
 * that something happened and nothing about what. This turns each event into one plain line —
 * `reads src/api/views.py`, `runs: find … | wc -l`, `thinking: which base classes govern this` —
 * and collapses the runs of identical verbs, so ten reads are one line saying ten.
 *
 * One implementation, used by the panel and by MCP, so the two never describe the same run
 * differently. The raw payload is never thrown away: this is a view, not a replacement.
 */
import type { EventRow } from "./db/types.js";

export type NarratedLine = {
  /** ISO timestamp of the first event folded into this line. */
  at: string;
  /** What happened, in one line of plain English. */
  text: string;
  /** A coarse grouping the panel can colour by: work, decision, result, problem. */
  tone: "work" | "decision" | "result" | "problem";
  /** How many events were folded together (1 unless a run was collapsed). */
  count: number;
  /** The event types folded in, for the tooltip. */
  type: string;
};

type Payload = Record<string, unknown>;

function read(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** The last path segment, which is what a person recognises. Full path kept when it is short. */
function shortPath(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/^\/workspace\/projects\/[^/]+\//, "");
  return clean.length <= 48 ? clean : `…/${clean.split("/").slice(-2).join("/")}`;
}

function shorten(value: string, max = 96): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** One event, one sentence. Returns undefined for the events that say nothing to a person. */
export function describeEvent(type: string, payload: Payload): Omit<NarratedLine, "at" | "count" | "type"> | undefined {
  switch (type) {
    case "run.state": {
      const status = read(payload, "status");
      const reason = read(payload, "reason");
      if (status === "running") return { text: "started working", tone: "work" };
      if (status === "waiting_human") {
        return { text: `waiting for a person (${reason || "permission"})`, tone: "decision" };
      }
      if (status === "ok") return { text: "finished", tone: "result" };
      return {
        text: `run ${status}${reason ? `: ${shorten(reason, 70)}` : ""}`,
        tone: status === "aborted" || status === "interrupted" ? "decision" : "problem",
      };
    }
    case "agent.thought":
      return { text: `thinking: ${shorten(read(payload, "textExcerpt"), 110)}`, tone: "work" };
    case "agent.message":
      return { text: `says: ${shorten(read(payload, "textExcerpt"), 110)}`, tone: "work" };
    case "tool.call": {
      const kind = read(payload, "kind");
      const path = read(payload, "path");
      const detail = read(payload, "detail") || read(payload, "title");
      if (kind === "read" || kind === "fetch_file") {
        return { text: path ? `reads ${shortPath(path)}` : "reads a file", tone: "work" };
      }
      if (kind === "edit" || kind === "write") {
        return { text: path ? `writes ${shortPath(path)}` : "writes a file", tone: "work" };
      }
      if (kind === "delete") {
        return { text: path ? `deletes ${shortPath(path)}` : "deletes a file", tone: "work" };
      }
      if (kind === "search") return { text: `searches: ${shorten(detail, 70)}`, tone: "work" };
      if (kind === "execute") {
        const command = detail && detail !== "Terminal" ? shorten(detail, 90) : "";
        return { text: command ? `runs: ${command}` : "runs a command", tone: "work" };
      }
      if (kind === "think") return { text: "thinking", tone: "work" };
      return { text: shorten(detail || "does something", 90), tone: "work" };
    }
    case "file.edit": {
      const path = shortPath(read(payload, "path"));
      const op = read(payload, "op");
      return { text: `${op === "delete" ? "deleted" : "wrote"} ${path}`, tone: "result" };
    }
    case "perm.request":
      return {
        text: `asks permission (${read(payload, "class")}): ${shorten(read(payload, "command") || read(payload, "title"), 70)}`,
        tone: "decision",
      };
    case "perm.verdict": {
      const verdict = read(payload, "verdict");
      const learned = read(payload, "learned");
      if (verdict === "allow") {
        return {
          text: learned ? "policy: allowed (learned before)" : `policy: allowed (${read(payload, "class")})`,
          tone: "decision",
        };
      }
      if (verdict === "require_human") return { text: "policy: asks a person", tone: "decision" };
      return { text: `policy: ${verdict} (${read(payload, "class")})`, tone: "decision" };
    }
    case "judge.verdict":
      return {
        text:
          payload.allowed === true
            ? `judge: allowed — ${shorten(read(payload, "reason"), 70)}`
            : `judge: sends it to a person${read(payload, "reason") ? ` — ${shorten(read(payload, "reason"), 60)}` : ""}`,
        tone: "decision",
      };
    case "doubt.opened":
      return { text: `doubt ${read(payload, "ref") || ""} opened`.trim(), tone: "decision" };
    case "doubt.answered":
      return {
        text: `doubt ${read(payload, "ref")} answered: ${read(payload, "choice")}`,
        tone: "decision",
      };
    case "advisor.consulted":
      return {
        text: `second opinion from ${read(payload, "engine")}: ${payload.agrees ? "agrees" : "disagrees"}`,
        tone: "decision",
      };
    case "verify.start":
      return { text: `verifying: ${shorten(read(payload, "cmd"), 70)}`, tone: "result" };
    case "verify.result":
      return {
        text: payload.exitCode === 0 ? "verify passed" : `verify failed (exit ${read(payload, "exitCode")})`,
        tone: payload.exitCode === 0 ? "result" : "problem",
      };
    case "git.commit":
      return {
        text: `committed ${read(payload, "sha").slice(0, 7)}: ${shorten(read(payload, "message"), 60)}`,
        tone: "result",
      };
    case "git.push":
      return { text: "pushed", tone: "result" };
    case "task.state":
      return { text: `task ${read(payload, "status")}`, tone: "result" };
    case "phase.state":
      return {
        text: `phase ${read(payload, "phaseRef")} ${read(payload, "status")}`,
        tone: "result",
      };
    case "deliverable.lint":
      return payload.ok === true
        ? undefined
        : { text: `deliverable needs compacting: ${read(payload, "file")}`, tone: "problem" };
    case "scratch.swept":
      return { text: `cleaned ${read(payload, "files")} temporary file(s)`, tone: "result" };
    case "run.untracked":
      return { text: `left ${read(payload, "count")} untracked file(s)`, tone: "problem" };
    case "vault.read":
      return { text: `used credentials: ${read(payload, "entryId")}`, tone: "decision" };
    case "system": {
      const reason = read(payload, "reason");
      if (!reason) return undefined;
      return { text: shorten(reason, 90), tone: reason.includes("fail") ? "problem" : "work" };
    }
    default:
      return undefined;
  }
}

function parsePayload(raw: string): Payload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Payload) : {};
  } catch {
    return {};
  }
}

/**
 * The last `limit` lines of a run, oldest first. Consecutive lines with the same verb are folded:
 * eight reads in a row become one line saying eight, because the interesting thing is that it read
 * eight files, not which eighth.
 */
export function narrate(events: EventRow[], limit = 10): NarratedLine[] {
  const lines: NarratedLine[] = [];
  for (const event of events) {
    const described = describeEvent(event.type, parsePayload(event.payload));
    if (!described) continue;
    const previous = lines[lines.length - 1];
    const verb = described.text.split(" ")[0];
    if (previous && previous.type === event.type && previous.text.split(" ")[0] === verb) {
      previous.count += 1;
      previous.text =
        previous.count === 2
          ? `${previous.text} (+1 more)`
          : previous.text.replace(/\(\+\d+ more\)$/, `(+${previous.count - 1} more)`);
      continue;
    }
    lines.push({ at: event.ts, count: 1, type: event.type, ...described });
  }
  return lines.slice(-limit);
}
