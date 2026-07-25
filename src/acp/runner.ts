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
import { DoubtService } from "../orchestrator/doubts.js";

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
  /** Set when the advisor settled the doubt and the task should run again (DO-02). */
  autoContinued?: { choice: string; decisionId: string };
  checkpointTag?: string;
};

export class TaskRunner {
  private readonly doubts: DoubtService;

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
    doubts?: DoubtService,
  ) {
    this.doubts = doubts ?? new DoubtService(config, repos, bus, agents);
  }

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

    const decisionContext = this.doubts.decisionContext(task.id);

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
      // On a re-run after a resolved doubt the agent must see what was settled (§8.2, §8.4).
      ...(decisionContext ? { decisionContext } : {}),
      // require_human opens a permission doubt and holds the ACP response until it is
      // answered or the slow clock runs out (DESIGN §6.5, §8.4).
      humanGate:
        input.humanGate ??
        ((request) =>
          this.doubts.gatePermission({
            project,
            task,
            runId: run.id,
            engine: profile.engine,
            actionClass: request.actionClass,
            title: request.title,
            reason: request.reason,
            options: request.options,
          })),
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
      // A second opinion may settle it and let the chain continue (DO-02); otherwise the
      // doubt opens with both positions attached (DO-03).
      const raised = await this.doubts.raise({
        project,
        task,
        runId: run.id,
        kind: "functional",
        engine: profile.engine,
        context: outcome.doubt.context,
        blocks: outcome.doubt.blocks,
        options: outcome.doubt.options,
        recommendation: outcome.doubt.recommendation ?? null,
      });

      if (raised.outcome === "auto_continue") {
        result.autoContinued = { choice: raised.choice, decisionId: raised.decisionId };
        if (raised.checkpointTag) result.checkpointTag = raised.checkpointTag;
        // The caller re-runs the task with the decision in its context (DESIGN §8.2).
        this.repos.tasks.setStatus(task.id, "queued");
        this.bus.emit("overview");
        return result;
      }
      result.doubtRef = raised.doubt.ref;
    }

    this.repos.tasks.setStatus(task.id, outcome.status);
    this.bus.emit("overview");
    return result;
  }
}
