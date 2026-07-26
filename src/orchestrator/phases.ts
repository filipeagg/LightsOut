/**
 * Project phases (TP-01, TP-05..08, DESIGN §16.2).
 *
 * A phase is the durable plan; a task is one attempt at it. Phases sit above the chain loop of
 * §5.2 and do not change it: launching a phase creates a task, and closing that task moves the
 * phase on. A `human` gate reuses the doubt machinery rather than inventing a second waiting
 * state, which is why it is answerable from Claude Desktop, from the panel and from
 * QUESTIONS.md with no code beyond a `kind`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { deliverablePath, lintDocument } from "../projects/deliverable.js";
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { DoubtRow, ProjectPhaseRow, ProjectRow } from "../db/types.js";
import type { ProjectTemplate } from "../templates/schema.js";
import { WORKSPACE_PREFIX } from "../templates/schema.js";
import { ProjectDocs } from "../projects/docs.js";
import type { Orchestrator } from "./orchestrator.js";

export type PhaseActor = "mcp" | "panel" | "system";

export type LaunchPhaseResult = {
  phaseId: string;
  phaseRef: string;
  taskId: string;
  started: boolean;
};

/** Options of the gate doubt. Stable ids so both surfaces can answer without guessing. */
export const GATE_CONTINUE = "A";
export const GATE_STOP = "B";

export class PhaseService {
  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
    private readonly orchestrator: Orchestrator,
  ) {}

  list(projectId: string): ProjectPhaseRow[] {
    return this.repos.phases.list(projectId);
  }

  /**
   * Copy a template's phases into `project_phases`, instructions frozen (TP-05). Editing the
   * template afterwards never rewrites a running project: a project is a snapshot of a recipe,
   * not a live reference to it.
   */
  materialise(projectId: string, template: ProjectTemplate): ProjectPhaseRow[] {
    const insert = this.repos.db.transaction((): ProjectPhaseRow[] =>
      template.phases.map((phase, position) =>
        this.repos.phases.create({
          projectId,
          position,
          phaseId: phase.id,
          title: phase.title,
          agentId: phase.agent,
          instructions: phase.instructions,
          deliverable: phase.deliverable ?? null,
          verifyCmd: phase.verify ?? null,
          gate: phase.gate,
          optional: phase.optional,
          repeatable: phase.repeatable,
        }),
      ),
    );
    const rows = insert();
    this.repos.events.append({
      type: "phase.state",
      payload: {
        projectId,
        status: "materialised",
        template: template.id,
        phases: rows.length,
        actor: "system",
      },
    });
    return rows;
  }

  /** An ad-hoc phase inserted at a position; its ref never collides with a template id (TP-08). */
  addAdhoc(
    actor: PhaseActor,
    projectId: string,
    input: {
      title: string;
      agentId: string;
      instructions: string;
      position?: number;
      deliverable?: string | null;
      verifyCmd?: string | null;
      gate?: "auto" | "human";
    },
  ): ProjectPhaseRow {
    this.requireAgent(input.agentId);
    const position = input.position ?? this.repos.phases.maxPosition(projectId) + 1;
    const phaseId = `adhoc-${this.repos.phases.adhocCount(projectId) + 1}`;
    const row = this.repos.phases.insertAt({
      projectId,
      position,
      phaseId,
      title: input.title,
      agentId: input.agentId,
      instructions: input.instructions,
      deliverable: input.deliverable ?? null,
      verifyCmd: input.verifyCmd ?? null,
      gate: input.gate ?? "auto",
    });
    this.emitPhase(row, actor);
    return row;
  }

  /** Resolve by ulid or by the template-level ref humans read. */
  private resolve(projectId: string, phase: string): ProjectPhaseRow {
    const found =
      this.repos.phases.getByRef(projectId, phase) ?? this.repos.phases.get(phase);
    if (!found || found.project_id !== projectId) {
      throw new Error(`unknown phase: ${phase}`);
    }
    return found;
  }

  /** A phase cannot run on a profile that is missing or switched off (AP-07, BA-06). */
  private requireAgent(agentId: string): void {
    const profile = this.agents.profile(agentId);
    if (!profile) throw new Error(`unknown agent profile: ${agentId}`);
    if (!profile.enabled) throw new Error(`agent profile ${agentId} is disabled (AP-07)`);
  }

  /**
   * `input` is what the person is actually asking for on this run of the phase. The template
   * instructions say things like "the user's raw request is in the task spec", and without a
   * way to put it there the first agent has nothing to work from and interrogates the empty
   * set. It is per launch rather than per project because a repeatable phase is launched again
   * for the next question, the next integration, the next piece of the plan.
   */
  async launchPhase(
    actor: PhaseActor,
    projectId: string,
    phaseRef: string,
    input?: string,
  ): Promise<LaunchPhaseResult> {
    const project = this.repos.projects.getOrThrow(projectId);
    const phase = this.resolve(projectId, phaseRef);

    if (phase.status === "running") {
      throw new Error(`phase ${phase.phase_id} is already running`);
    }
    if (phase.status !== "pending" && !phase.repeatable) {
      throw new Error(
        `phase ${phase.phase_id} is ${phase.status} and is not repeatable (TP-07)`,
      );
    }
    this.requireAgent(phase.agent_id);

    const chain = this.chainFor(project);
    const launched = this.orchestrator.launchTask({
      projectId: project.id,
      chainId: chain,
      title: phase.title,
      spec: this.buildSpec(phase, input),
      agentId: phase.agent_id,
      ...(phase.verify_cmd !== null ? { verifyCmd: phase.verify_cmd } : {}),
    });
    const taskId = launched.taskIds[0]!;
    const running = this.repos.phases.markRunning(phase.id, taskId);
    this.emitPhase(running, actor);
    this.bus.emit("overview");

    return {
      phaseId: running.id,
      phaseRef: running.phase_id,
      taskId,
      started: launched.started,
    };
  }

  /** One chain per project (§16.2); created on demand for a project older than phase 9. */
  private chainFor(project: ProjectRow): string {
    const existing =
      this.repos.chains.activeForProject(project.id) ??
      this.repos.chains.listByProject(project.id)[0];
    if (existing) return existing.id;
    return this.repos.chains.create({ projectId: project.id, title: project.name }).id;
  }

  /** The task spec: the frozen instructions, the request, and what to leave behind (BA-04). */
  buildSpec(phase: ProjectPhaseRow, input?: string): string {
    const parts = [phase.instructions.trim()];
    if (input?.trim()) {
      parts.push(`## Request\n\n${input.trim()}`);
    }
    if (phase.deliverable) {
      parts.push(
        `Deliverable: ${phase.deliverable}. The phase is not complete until it exists; ` +
          `reporting success without it fails the phase.`,
      );
    }
    return parts.join("\n\n");
  }

  /**
   * A task reached a terminal state. Advance the phase it represents, if any: a failed task
   * fails the phase, a missing deliverable fails it too, and a `human` gate stops to ask
   * instead of starting the next one (§16.2).
   */
  async onTaskClosed(taskId: string): Promise<void> {
    const phase = this.repos.phases.getByTask(taskId);
    if (!phase || phase.status !== "running") return;
    const task = this.repos.tasks.getOrThrow(taskId);
    const project = this.repos.projects.getOrThrow(task.project_id);

    if (task.status !== "ok") {
      this.emitPhase(this.repos.phases.setStatus(phase.id, "failed"), "system", task.status);
      this.bus.emit("overview");
      return;
    }

    if (!(await this.deliverablePresent(project, phase))) {
      this.emitPhase(
        this.repos.phases.setStatus(phase.id, "failed"),
        "system",
        "deliverable missing",
      );
      this.bus.emit("overview");
      return;
    }

    // Machine-first format check (BA-08, §20.4): recorded, never a failure. The teeth are in the
    // next prompt, which tells the agent to compact the document before adding to it.
    await this.lintDeliverable(project, phase, taskId);

    const done = this.repos.phases.setStatus(phase.id, "done");
    this.emitPhase(done, "system");

    if (done.gate === "human") {
      await this.openGate(project, done);
      this.bus.emit("overview");
      return;
    }

    const next = this.repos.phases.nextPending(project.id);
    if (next) await this.launchPhase("system", project.id, next.phase_id);
    this.bus.emit("overview");
  }

  /** Skip an optional phase and move on (TP-07). */
  async skipPhase(
    actor: PhaseActor,
    projectId: string,
    phaseRef: string,
  ): Promise<ProjectPhaseRow> {
    const phase = this.resolve(projectId, phaseRef);
    if (!phase.optional) throw new Error(`phase ${phase.phase_id} is not optional`);
    if (phase.status === "running") {
      throw new Error(`phase ${phase.phase_id} is running; abort it before skipping`);
    }
    const skipped = this.repos.phases.setStatus(phase.id, "skipped");
    this.emitPhase(skipped, actor);
    const next = this.repos.phases.nextPending(projectId);
    if (next) await this.launchPhase("system", projectId, next.phase_id);
    this.bus.emit("overview");
    return skipped;
  }

  /**
   * The gate doubt: a fixed two-option confirmation. It skips the advisor consultation of §8.2
   * on purpose — the whole point of a gate is that a person looks, so asking the other engine
   * first would spend tokens producing an opinion nobody needs.
   */
  private async openGate(project: ProjectRow, phase: ProjectPhaseRow): Promise<DoubtRow> {
    const next = this.repos.phases.nextPending(project.id);
    const context = [
      `Phase "${phase.title}" (${phase.phase_id}) finished.`,
      phase.deliverable ? `Deliverable: ${phase.deliverable}` : "",
      "It is waiting for a person to look before the project goes on.",
    ]
      .filter(Boolean)
      .join("\n");

    const doubt = this.repos.doubts.open({
      projectId: project.id,
      taskId: phase.task_id!,
      kind: "gate",
      context,
      blocks: next ? `phase ${next.phase_id} (${next.title})` : "the end of the project",
      options: [
        {
          id: GATE_CONTINUE,
          text: next ? `Continue to ${next.title}` : "Close the project here",
        },
        { id: GATE_STOP, text: "Stop here" },
      ],
      recommendation: GATE_CONTINUE,
    });
    this.repos.events.append({
      type: "doubt.opened",
      payload: { doubtId: doubt.id, ref: doubt.ref, kind: "gate", phaseId: phase.id },
    });
    await this.mirrorGate(project, doubt);
    this.bus.emit("doubt", { doubtId: doubt.id });
    return doubt;
  }

  /** A gate reaches QUESTIONS.md like any other doubt (DO-01). */
  private async mirrorGate(project: ProjectRow, doubt: DoubtRow): Promise<void> {
    await new ProjectDocs(this.repos, project).appendQuestion({
      ref: doubt.ref,
      context: doubt.context,
      blocks: doubt.blocks,
      options: this.repos.doubts.options(doubt),
      recommendation: doubt.recommendation,
      status: "open",
    });
  }

  /**
   * A gate was answered. "Continue" starts the next pending phase; anything else leaves the
   * project where it is, which is a decision, not a failure.
   */
  async onGateAnswered(doubt: DoubtRow, choice: string): Promise<boolean> {
    if (choice !== GATE_CONTINUE) return false;
    const next = this.repos.phases.nextPending(doubt.project_id);
    if (!next) return false;
    await this.launchPhase("system", doubt.project_id, next.phase_id);
    return true;
  }

  /**
   * Is the phase's deliverable on disk (BA-04)? A deliverable containing whitespace is a
   * description rather than a path and cannot be checked; one containing `*` is a glob, and
   * the question is whether anything matches, not whether one exact file exists.
   */
  private async deliverablePresent(
    project: ProjectRow,
    phase: ProjectPhaseRow,
  ): Promise<boolean> {
    const declared = phase.deliverable?.trim();
    if (!declared) return true;
    if (/\s/.test(declared)) return true;

    const relative = declared.startsWith(WORKSPACE_PREFIX)
      ? declared.slice(WORKSPACE_PREFIX.length)
      : declared;
    const root = declared.startsWith(WORKSPACE_PREFIX) ? this.config.workspace : project.path;
    const target = path.resolve(root, relative);

    if (!declared.includes("*")) {
      try {
        await stat(target);
        return true;
      } catch {
        return false;
      }
    }
    return anyMatch(root, relative);
  }

  /**
   * Measure the deliverable against the machine-first format (BA-07, BA-08). Only a Markdown file
   * that is a real path is measured: a description cannot be read, and another format is not ours
   * to judge (§20.2). Never throws and never changes the phase status.
   */
  private async lintDeliverable(
    project: ProjectRow,
    phase: ProjectPhaseRow,
    taskId: string,
  ): Promise<void> {
    const target = deliverablePath(this.config.workspace, project.path, phase.deliverable);
    if (!target) return;
    try {
      const text = await readFile(target, "utf8");
      const lint = lintDocument(text);
      const run = this.repos.runs.listByTask(taskId)[0];
      this.repos.events.append({
        ...(run ? { runId: run.id } : {}),
        type: "deliverable.lint",
        payload: {
          phaseId: phase.id,
          phaseRef: phase.phase_id,
          file: phase.deliverable,
          ok: lint.ok,
          exempt: lint.exempt,
          metrics: lint.metrics,
          reasons: lint.reasons,
        },
      });
    } catch {
      // Unreadable or not a file: the presence check above already had its say.
    }
  }

  private emitPhase(phase: ProjectPhaseRow, actor: PhaseActor, reason?: string): void {
    this.repos.events.append({
      type: "phase.state",
      payload: {
        phaseId: phase.id,
        phaseRef: phase.phase_id,
        projectId: phase.project_id,
        status: phase.status,
        actor,
        ...(reason ? { reason } : {}),
      },
    });
  }
}

/** Minimal glob: `*` matches within one segment, `**` across segments. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split(/[\\/]/)
    .map((segment) =>
      segment === "**"
        ? " DOUBLE "
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/")
    .replace(/ DOUBLE \//g, "(?:.*/)?")
    .replace(/ DOUBLE /g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True when at least one file under `root` matches the glob. */
async function anyMatch(root: string, pattern: string): Promise<boolean> {
  const re = globToRegExp(pattern);
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (await walk(path.join(dir, entry.name), rel)) return true;
        continue;
      }
      if (re.test(rel)) return true;
    }
    return false;
  };
  return walk(root, "");
}
