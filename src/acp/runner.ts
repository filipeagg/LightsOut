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
import type { KnowledgeLoader } from "../knowledge/loader.js";
import { buildKnowledgeBlock } from "../knowledge/inject.js";
import { renderVaultIndex, type Vault } from "../vault/vault.js";

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

/** Only the part of the health probe the runner needs, so a test can pass a stub (§11.3). */
export type HealthInvalidator = {
  noteAuthFailure: (engine: "claude" | "codex", detail: string) => void;
  clearAuthFailure: (engine: "claude" | "codex") => void;
};

export class TaskRunner {
  private readonly doubts: DoubtService;

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    private readonly agents: AgentsLoader,
    doubts?: DoubtService,
    /** Optional: when present, an auth failure mid-run flips engine health (§11.3). */
    private readonly health?: HealthInvalidator,
    /** Phase 9 material; absent in the phase 3 CLI, which runs a task with neither. */
    private readonly context?: {
      knowledge?: KnowledgeLoader;
      vault?: Vault;
    },
  ) {
    this.doubts = doubts ?? new DoubtService(config, repos, bus, agents);
  }

  /**
   * Curated knowledge and credentials for this run (KB-04, §18). The vault is resolved only
   * when the run's pack grants network access: a run that cannot reach anything has no use for
   * a token, and not putting it in the environment is cheaper than trusting it not to look.
   */
  private async runContext(
    project: ProjectRow,
    task: TaskRow,
    pack: PolicyPack | undefined,
  ): Promise<{
    knowledgeBlock?: string;
    vaultIndex?: string;
    vaultEnv?: Record<string, string>;
    vaultReads: { entryId: string; fields: string[] }[];
    writableKnowledgeBase?: string;
  }> {
    const attachments = this.repos.projectKnowledge.list(project.id);
    const writable = attachments.find((row) => row.writable === 1)?.base_id;

    let knowledgeBlock: string | undefined;
    if (this.context?.knowledge && attachments.length > 0) {
      const phase = this.repos.phases.getByTask(task.id);
      const block = await buildKnowledgeBlock(
        this.context.knowledge,
        attachments.map((row) => row.base_id),
        {
          budgetChars: this.config.knowledgeBudgetChars,
          tags: attachments.map((row) => row.kind),
          phaseTitle: phase?.title ?? task.title,
        },
      );
      if (block.text) knowledgeBlock = block.text;
    }

    const grantsNetwork = pack?.rules.some(
      (rule) => rule.class === "network" && rule.verdict !== "deny",
    );
    if (!this.context?.vault || !grantsNetwork) {
      return {
        ...(knowledgeBlock ? { knowledgeBlock } : {}),
        vaultReads: [],
        ...(writable ? { writableKnowledgeBase: writable } : {}),
      };
    }

    const resolved = await this.context.vault.resolveForRun({
      projectId: project.id,
      testOnlyRequired: pack?.vault?.test_only_required ?? false,
    });
    const index = renderVaultIndex(resolved);
    return {
      ...(knowledgeBlock ? { knowledgeBlock } : {}),
      ...(index ? { vaultIndex: index } : {}),
      ...(Object.keys(resolved.env).length > 0 ? { vaultEnv: resolved.env } : {}),
      vaultReads: resolved.reads,
      ...(writable ? { writableKnowledgeBase: writable } : {}),
    };
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

    const agentPack = this.agents.pack(profile.policy);
    const context = await this.runContext(project, task, input.projectPack ?? agentPack);

    const run = this.repos.runs.start({
      taskId: task.id,
      engine: profile.engine,
      model: profile.model ?? null,
    });
    this.repos.tasks.setStatus(task.id, "running");

    // Field names only, never values (VT-05).
    for (const read of context.vaultReads) {
      this.repos.vaultAudit.record(run.id, read.entryId, read.fields);
      this.repos.events.append({
        runId: run.id,
        type: "vault.read",
        payload: { entryId: read.entryId, fields: read.fields },
      });
    }
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
      workspacePath: this.config.workspace,
      // On a re-run after a resolved doubt the agent must see what was settled (§8.2, §8.4).
      ...(decisionContext ? { decisionContext } : {}),
      ...(context.knowledgeBlock ? { knowledgeBlock: context.knowledgeBlock } : {}),
      ...(context.vaultIndex ? { vaultIndex: context.vaultIndex } : {}),
      ...(context.vaultEnv ? { vaultEnv: context.vaultEnv } : {}),
      ...(context.writableKnowledgeBase
        ? { writableKnowledgeBase: context.writableKnowledgeBase }
        : {}),
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

    // `session.start()` contains its own failures, but the ACP SDK can also reject a promise
    // this code never awaits — a transport that closes mid-request rejects everything pending —
    // and an unhandled rejection is fatal to the whole process by default. So the call is
    // wrapped: whatever escapes becomes an `error` outcome and travels down the ordinary failure
    // path, which finishes the run, fails the task, pauses the chain and records recovery info.
    // A dead adapter must cost one run, never the orchestrator (OR-05, RT-07).
    let outcome: RunOutcome;
    try {
      outcome = await session.start();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.repos.events.append({
        runId: run.id,
        type: "system",
        payload: { reason: "adapter failure", detail },
      });
      outcome = {
        status: "error",
        summary: "",
        exitReason: `adapter failure: ${detail}`,
        sentinelMissing: true,
        ...(session.acpSession ? { acpSession: session.acpSession } : {}),
      };
    }

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

    // Credentials died mid-run (§11.3): drop the cached probe so the next read reports the
    // engine as unauthenticated, and record it as a system.auth event so the panel's attention
    // strip and the history both say "reconnect the engine" instead of "the task failed".
    if (outcome.authRequired) {
      this.health?.noteAuthFailure(profile.engine, outcome.exitReason);
      this.repos.events.append({
        runId: run.id,
        type: "system.auth",
        payload: { engine: profile.engine, reason: "AUTH_REQUIRED", detail: outcome.exitReason },
      });
      this.bus.emit("health");
    } else if (outcome.status === "ok") {
      // The engine demonstrably works; clear any failure remembered from an earlier run.
      this.health?.clearAuthFailure(profile.engine);
    }

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
