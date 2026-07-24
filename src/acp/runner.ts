/**
 * One task, one run: the seam the orchestrator will call in phase 4 (SR-01..07).
 * Everything that outlives the ACP turn happens here: run row lifecycle, task status,
 * doubt creation from the sentinel, and the policy layers for the run.
 */
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import { PolicyEngine } from "../policy/engine.js";
import type { PolicyPack } from "../policy/schema.js";
import type { ProjectRow, TaskRow } from "../db/types.js";
import { RunSession, type HumanGate, type RunOutcome } from "./session.js";

export type RunTaskInput = {
  project: ProjectRow;
  task: TaskRow;
  /** Per-project override pack from lightsout.yaml (PE-05); phase 4 loads it. */
  projectPack?: PolicyPack | undefined;
  humanGate?: HumanGate | undefined;
  onStderr?: ((line: string) => void) | undefined;
};

export type RunTaskResult = {
  runId: string;
  outcome: RunOutcome;
  /** Human-friendly ref of the doubt opened, when the agent raised one. */
  doubtRef?: string;
};

export class TaskRunner {
  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
  ) {}

  private adapterCommand(engine: "claude" | "codex"): string {
    return engine === "claude" ? this.config.adapterClaude : this.config.adapterCodex;
  }

  async run(input: RunTaskInput): Promise<RunTaskResult> {
    const { project, task } = input;
    const profile = this.agents.profileOrThrow(task.agent_id);
    const instructions = this.agents.instructionsFor(profile);

    const policy = new PolicyEngine({
      project: input.projectPack,
      agent: this.agents.pack(profile.policy),
      default: this.agents.pack("default"),
    });

    const run = this.repos.runs.start({
      taskId: task.id,
      engine: profile.engine,
      model: profile.model ?? null,
    });
    this.repos.tasks.setStatus(task.id, "running");
    this.bus.emit("overview");

    const session = new RunSession({
      repos: this.repos,
      bus: this.bus,
      policy,
      project,
      task,
      run,
      profile,
      instructions,
      adapterCommand: this.adapterCommand(profile.engine),
      limits: {
        timeoutMin:
          task.level === "quick" ? this.config.timeoutQuickMin : this.config.timeoutFullMin,
        inactivityMin: this.config.inactivityMin,
      },
      ...(input.humanGate ? { humanGate: input.humanGate } : {}),
      ...(input.onStderr ? { onStderr: input.onStderr } : {}),
    });

    const outcome = await session.start();

    this.repos.runs.finish(run.id, {
      status: outcome.status,
      exitReason: outcome.exitReason,
      summary: outcome.summary || null,
      error: outcome.status === "error" ? outcome.exitReason : null,
      tokensIn: outcome.tokensIn ?? null,
      tokensOut: outcome.tokensOut ?? null,
      costUsd: outcome.costUsd ?? null,
    });
    this.repos.events.append({
      runId: run.id,
      type: "run.state",
      payload: { status: outcome.status, reason: outcome.exitReason },
    });

    const result: RunTaskResult = { runId: run.id, outcome };

    if (outcome.status === "doubt" && outcome.doubt) {
      const doubt = this.repos.doubts.open({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        kind: "functional",
        context: outcome.doubt.context,
        blocks: outcome.doubt.blocks,
        options: outcome.doubt.options,
        recommendation: outcome.doubt.recommendation ?? null,
      });
      this.repos.events.append({
        runId: run.id,
        type: "doubt.opened",
        payload: { doubtId: doubt.id, ref: doubt.ref },
      });
      result.doubtRef = doubt.ref;
      // The advisor second opinion and auto-continue are phase 5 (DO-02).
    }

    this.repos.tasks.setStatus(task.id, outcome.status);
    this.bus.emit("overview");
    return result;
  }
}
