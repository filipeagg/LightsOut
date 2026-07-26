/**
 * Managed doc sections (PM-02, DESIGN §9.2).
 *
 * `STATE.md` mixes free text with a machine-owned block regenerated from the database at
 * every task close. Everything outside the markers is never touched. `PLAN.md` carries one
 * checkbox per task with its id in a trailing tag, and the orchestrator flips them by id.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Repos } from "../db/repos/index.js";
import type { ChainRow, ProjectRow, TaskRow } from "../db/types.js";

export const MANAGED_BEGIN = "<!-- lightsout:begin -->";
export const MANAGED_END = "<!-- lightsout:end -->";

/** Replace the managed block, appending it when the markers are absent. */
export function replaceManagedBlock(content: string, block: string): string {
  const managed = `${MANAGED_BEGIN}\n${block.trim()}\n${MANAGED_END}`;
  const start = content.indexOf(MANAGED_BEGIN);
  const end = content.indexOf(MANAGED_END);
  if (start === -1 || end === -1 || end < start) {
    const base = content.trimEnd();
    return base ? `${base}\n\n${managed}\n` : `${managed}\n`;
  }
  return content.slice(0, start) + managed + content.slice(end + MANAGED_END.length);
}

/** `- [ ] Title  <!-- lo:<taskId> -->` → checked/unchecked by id. */
export function flipPlanCheckbox(content: string, taskId: string, done: boolean): string {
  const marker = `<!-- lo:${taskId} -->`;
  return content
    .split("\n")
    .map((line) => {
      if (!line.includes(marker)) return line;
      return line.replace(/^(\s*[-*]\s*)\[[ xX]\]/, `$1[${done ? "x" : " "}]`);
    })
    .join("\n");
}

export function planLine(task: TaskRow, done: boolean): string {
  return `- [${done ? "x" : " "}] ${task.title}  <!-- lo:${task.id} -->`;
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

export class ProjectDocs {
  constructor(
    private readonly repos: Repos,
    private readonly project: ProjectRow,
  ) {}

  private file(name: string): string {
    return path.join(this.project.path, "doc", name);
  }

  /**
   * Compose the machine-owned STATE.md block from the database (never from memory). Strict
   * `key: value`, because an agent reads this block on every run (BA-07, DESIGN §20).
   */
  buildStateBlock(chain: ChainRow | undefined): string {
    const lines: string[] = [`state.updated: ${new Date().toISOString().slice(0, 19)}Z`];
    if (chain) {
      const tasks = this.repos.tasks.listByChain(chain.id);
      const done = tasks.filter((t) => t.status === "ok").length;
      const current = tasks.find((t) => t.status === "running") ?? tasks.find(
        (t) => t.status === "queued",
      );
      const failed = tasks.find((t) =>
        ["verify_failed", "timeout", "stuck", "error", "aborted", "interrupted"].includes(
          t.status,
        ),
      );
      lines.push(`chain.title: ${chain.title}`);
      lines.push(`chain.status: ${chain.status}`);
      lines.push(`chain.progress: ${done}/${tasks.length}`);
      if (failed) {
        lines.push(`chain.blocked_on: ${failed.title}`);
        lines.push(`chain.blocked_status: ${failed.status}`);
      }
      const lastOk = [...tasks].reverse().find((t) => t.status === "ok");
      if (lastOk) lines.push(`task.last_ok: ${lastOk.title}`);
      lines.push(`task.next: ${current ? current.title : "none"}`);
    } else {
      lines.push("chain.status: none");
    }

    const decision = this.repos.decisions.latest(this.project.id);
    if (decision) {
      lines.push(`decision.last: ${decision.choice}`);
      lines.push(`decision.kind: ${decision.kind}`);
      lines.push(`decision.at: ${decision.created_at.slice(0, 10)}`);
    }

    const open = this.repos.doubts.listOpen(this.project.id);
    lines.push(`doubts.open: ${open.length > 0 ? open.map((d) => d.ref).join(",") : "none"}`);
    return lines.join("\n");
  }

  /** Rewrite only the managed block of STATE.md (PM-02). */
  async updateState(chain?: ChainRow): Promise<void> {
    const file = this.file("STATE.md");
    await mkdir(path.dirname(file), { recursive: true });
    const current = (await readOrEmpty(file)) || "# STATE\n";
    await writeFile(file, replaceManagedBlock(current, this.buildStateBlock(chain)), "utf8");
  }

  /** Add missing task lines to PLAN.md and tick the ones already done. */
  async syncPlan(chain: ChainRow): Promise<void> {
    const file = this.file("PLAN.md");
    await mkdir(path.dirname(file), { recursive: true });
    let content = (await readOrEmpty(file)) || `# PLAN\n\n## ${chain.title}\n`;
    const tasks = this.repos.tasks.listByChain(chain.id);

    for (const task of tasks) {
      const done = task.status === "ok";
      if (content.includes(`<!-- lo:${task.id} -->`)) {
        content = flipPlanCheckbox(content, task.id, done);
      } else {
        content = `${content.trimEnd()}\n${planLine(task, done)}\n`;
      }
    }
    await writeFile(file, content, "utf8");
  }

  /** Append-only decision log entry (DESIGN §8.3). */
  async appendDecision(input: {
    ref?: string;
    kind: string;
    question: string;
    choice: string;
    rationale?: string | null;
  }): Promise<void> {
    const file = this.file("DECISIONS.md");
    await mkdir(path.dirname(file), { recursive: true });
    const current = (await readOrEmpty(file)) || "# DECISIONS\n";
    // Machine-first (BA-07): the heading is the id, the body is key: value, one fact per line.
    const header = `## ${input.ref ?? "decision"}`;
    const body = [
      `question: ${input.question}`,
      `choice: ${input.choice}`,
      `kind: ${input.kind}`,
      `at: ${new Date().toISOString().slice(0, 10)}`,
      input.rationale ? `why: ${input.rationale}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    await writeFile(file, `${current.trimEnd()}\n\n${header}\n\n${body}\n`, "utf8");
  }

  /**
   * Mirror of a doubt in QUESTIONS.md (DO-01, DESIGN §8.3). The database is the source of
   * truth: this block is regenerated on every transition and never parsed back. A block for
   * the same ref is replaced, so answering a doubt updates its entry instead of duplicating it.
   */
  async appendQuestion(input: {
    ref: string;
    context: string;
    blocks: string;
    options: { id: string; text: string }[];
    recommendation?: string | null;
    secondOpinion?: string;
    status?: string;
    answer?: string | null;
  }): Promise<void> {
    const file = this.file("QUESTIONS.md");
    await mkdir(path.dirname(file), { recursive: true });
    const current = (await readOrEmpty(file)) || "# QUESTIONS\n";
    const status = input.status ?? "open";
    const marker = status === "open" ? "@DOUBT-OPEN" : "@DOUBT-CLOSED";

    // Machine-first (BA-07, DESIGN §20): key: value only. The context is the agent's own
    // sentence and is kept as one value, on one line, rather than reflowed into a paragraph.
    const block = [
      `${marker} ${input.ref}`,
      `### ${input.ref}`,
      `status: ${status}`,
      `context: ${input.context.replace(/\s*\n\s*/g, " ").trim()}`,
      `blocks: ${input.blocks.replace(/\s*\n\s*/g, " ").trim()}`,
      ...input.options.map((o) => `option.${o.id}: ${o.text}`),
      input.recommendation ? `recommendation: ${input.recommendation}` : "",
      input.secondOpinion ? `second_opinion: ${input.secondOpinion}` : "",
      `answer: ${input.answer ?? "pending"}`,
      `@DOUBT-END ${input.ref}`,
    ]
      .filter((line) => line !== "")
      .join("\n");

    // Replace an existing block for this ref, otherwise append.
    const startMarker = new RegExp(`^@DOUBT-(?:OPEN|CLOSED) ${input.ref}$`, "m");
    const endMarker = `@DOUBT-END ${input.ref}`;
    const start = current.search(startMarker);
    const end = current.indexOf(endMarker);
    if (start !== -1 && end > start) {
      const updated =
        current.slice(0, start) + block + current.slice(end + endMarker.length);
      await writeFile(file, updated, "utf8");
      return;
    }
    await writeFile(file, `${current.trimEnd()}\n\n${block}\n`, "utf8");
  }
}
