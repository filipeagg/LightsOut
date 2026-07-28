/**
 * Chain loop (OR-01..08, PM-02, PM-04, PM-05, DESIGN §5).
 *
 * One task at a time per project, `LO_MAX_PARALLEL` across projects. When a task ends ok the
 * orchestrator consolidates git, updates the managed docs, runs the verify gate, pushes if the
 * policy allows it, and starts the next task. Any other end state pauses the chain with its
 * recovery info persisted; nothing is retried silently.
 */
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { ChainRow, DoubtRow, ProjectRow, TaskLevel, TaskRow } from "../db/types.js";
import { TaskRunner, type HealthInvalidator } from "../acp/runner.js";
import { LiveRuns } from "../acp/live.js";
import { ProjectGit } from "../projects/git.js";
import { ProjectDocs } from "../projects/docs.js";
import { ensureScratch, sweep } from "../projects/hygiene.js";
import path from "node:path";
import { readProjectConfig } from "../projects/config.js";
import { runVerify } from "./verify.js";
import { RunLocks } from "./locks.js";
import { composeSpec, requireExpects, requireRequest } from "./spec.js";
import type { Capability } from "../policy/capabilities.js";
import type { RunTaskInput, RunTaskResult } from "../acp/runner.js";
import { DoubtService } from "./doubts.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { Vault } from "../vault/vault.js";

/** The one seam the chain loop needs from the ACP layer; injectable for tests. */
export type TaskRunnerLike = { run: (input: RunTaskInput) => Promise<RunTaskResult> };

export type LaunchTaskInput = {
  projectId: string;
  title: string;
  spec: string;
  /** What comes back, in the caller's words. Required on every launch (OR-10). */
  expects: string;
  agentId: string;
  /** Declared needs and per-run grants (PE-12); validated by the caller before it gets here. */
  needs?: Capability[];
  grants?: Capability[];
  /**
   * The engine, model and reasoning level chosen for this launch (AP-09). Validated against the
   * catalog by the caller (`Actions`, OR-11); omitted means the agent profile decides, resolved at
   * run time so a later profile edit still reaches the task.
   */
  engine?: string | null;
  model?: string | null;
  reasoning?: string | null;
  level?: TaskLevel;
  verifyCmd?: string | null;
  /** Append to this chain instead of creating one. */
  chainId?: string;
};

export type LaunchChainInput = {
  projectId: string;
  title: string;
  tasks: Omit<LaunchTaskInput, "projectId" | "chainId">[];
};

export type LaunchResult = {
  chainId: string;
  taskIds: string[];
  started: boolean;
  queued: boolean;
};

export class Orchestrator {
  private readonly locks: RunLocks;
  private readonly runner: TaskRunnerLike;
  private readonly doubts: DoubtService;
  /** In-flight chain drivers, so shutdown can wait for them. */
  private readonly driving = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly bus: Bus,
    agents: AgentsLoader,
    /** Defaults to the real ACP runner; tests inject a deterministic one. */
    runner?: TaskRunnerLike,
    doubts?: DoubtService,
    /** Passed through so an auth failure mid-run flips engine health (§11.3). */
    health?: HealthInvalidator,
    /** Curated knowledge and the vault, when this process has them (KB-04, §18). */
    context?: { knowledge?: KnowledgeLoader; vault?: Vault },
  ) {
    this.locks = new RunLocks(config.maxParallel);
    this.doubts = doubts ?? new DoubtService(config, repos, bus, agents);
    // The registry is shared with the runner, because stopping a run means reaching the session
    // object the runner holds (OR-06, §5.4). An injected runner brings its own if it has one.
    const real =
      runner ??
      new TaskRunner(config, repos, bus, agents, this.doubts, health, context, new LiveRuns());
    this.runner = real;
    this.live = (real as { live?: LiveRuns }).live ?? new LiveRuns();
  }

  /** Sessions currently driving an adapter; the handle a stop needs (OR-06). */
  readonly live: LiveRuns;

  /**
   * What the phase layer registers so a closed task can advance its phase (§16.2). It is a
   * hook rather than a constructor dependency because the phase service launches tasks
   * through this orchestrator, and the two cannot both be built first.
   */
  private phaseHook: ((taskId: string) => Promise<void>) | undefined;
  /** Answers a `gate` doubt; registered by the phase service alongside the hook. */
  private gateHook: ((doubt: DoubtRow, choice: string) => Promise<boolean>) | undefined;

  setPhaseHooks(hooks: {
    onTaskClosed: (taskId: string) => Promise<void>;
    onGateAnswered: (doubt: DoubtRow, choice: string) => Promise<boolean>;
  }): void {
    this.phaseHook = hooks.onTaskClosed;
    this.gateHook = hooks.onGateAnswered;
  }

  get activeRuns(): { projectId: string; runId: string }[] {
    return this.locks.snapshot();
  }

  /** Append tasks to a new or existing chain and start it when the project is free. */
  launchChain(input: LaunchChainInput): LaunchResult {
    const project = this.repos.projects.getOrThrow(input.projectId);
    const chain = this.repos.chains.create({
      projectId: project.id,
      title: input.title,
    });
    const tasks = this.repos.tasks.createMany(
      input.tasks.map((task) => ({
        chainId: chain.id,
        projectId: project.id,
        title: task.title,
        // OR-10: what is asked, then what is expected back. Refused when either is missing.
        spec: composeSpec({
          spec: requireRequest(task.spec, `task "${task.title}"`),
          expects: requireExpects(task.expects, `task "${task.title}"`),
        }),
        agentId: task.agentId,
        ...(task.level ? { level: task.level } : {}),
        ...(task.verifyCmd !== undefined ? { verifyCmd: task.verifyCmd } : {}),
        ...(task.needs?.length ? { needs: task.needs } : {}),
        ...(task.grants?.length ? { grants: task.grants } : {}),
        // AP-09: per task, so one chain can put a cheap model on the mechanical steps.
        ...(task.engine ? { engine: task.engine } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.reasoning ? { reasoning: task.reasoning } : {}),
      })),
    );
    this.repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "active", tasks: tasks.length },
    });
    this.bus.emit("overview");

    const started = this.tryDrive(project, chain);
    return {
      chainId: chain.id,
      taskIds: tasks.map((t) => t.id),
      started,
      queued: !started,
    };
  }

  launchTask(input: LaunchTaskInput): LaunchResult {
    const project = this.repos.projects.getOrThrow(input.projectId);
    const chain = input.chainId
      ? this.repos.chains.getOrThrow(input.chainId)
      : (this.repos.chains.activeForProject(project.id) ??
        this.repos.chains.create({ projectId: project.id, title: input.title }));

    const task = this.repos.tasks.create({
      chainId: chain.id,
      projectId: project.id,
      title: input.title,
      spec: composeSpec({
        spec: requireRequest(input.spec, `task "${input.title}"`),
        expects: requireExpects(input.expects, `task "${input.title}"`),
      }),
      agentId: input.agentId,
      ...(input.level ? { level: input.level } : {}),
      ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
      ...(input.needs?.length ? { needs: input.needs } : {}),
      ...(input.grants?.length ? { grants: input.grants } : {}),
      // AP-09: the launch's choice of engine and model, already validated against the catalog.
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    });
    if (chain.status !== "active") this.repos.chains.setStatus(chain.id, "active");
    this.bus.emit("overview");

    const started = this.tryDrive(project, chain);
    return { chainId: chain.id, taskIds: [task.id], started, queued: !started };
  }

  /**
   * Start driving a chain if the project is free and there is capacity (OR-08: otherwise the
   * tasks stay `queued` and a later completion picks them up).
   */
  private tryDrive(project: ProjectRow, chain: ChainRow): boolean {
    if (this.locks.isLocked(project.id) || this.locks.atCapacity) return false;
    if (!this.repos.tasks.nextQueued(chain.id)) return false;

    // `drive` is started, not awaited, so its rejection has nowhere to go: without this catch an
    // error anywhere in the chain loop is an unhandled rejection, and Node kills the process by
    // default. That is how one dead adapter took the whole orchestrator down and left the chain
    // paused with no explanation. Nothing here may throw.
    const driver = this.drive(project.id, chain.id)
      .catch((err: unknown) => this.driveCrashed(project.id, chain.id, err))
      .finally(() => {
        this.driving.delete(chain.id);
      });
    this.driving.set(chain.id, driver);
    return true;
  }

  /**
   * Last resort: the chain loop itself failed. Pause the chain and say why, so the state the user
   * sees is "paused because X" rather than a chain that stopped moving for no visible reason.
   */
  private driveCrashed(projectId: string, chainId: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      this.repos.chains.setStatus(chainId, "paused");
      this.repos.events.append({
        type: "chain.state",
        payload: { chainId, projectId, status: "paused", reason: "chain loop failed", detail },
      });
      this.bus.emit("overview");
    } catch {
      // The database is the last thing standing; if it is gone too, stderr is all we have.
    }
    console.error(`[chain:${chainId}] loop failed: ${detail}`);
  }

  /** Wait for every in-flight chain: used by graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.driving.values()]);
  }

  private async drive(projectId: string, chainId: string): Promise<void> {
    for (;;) {
      const project = this.repos.projects.getOrThrow(projectId);
      const chain = this.repos.chains.getOrThrow(chainId);
      if (chain.status !== "active") return;

      const task = this.repos.tasks.nextQueued(chainId);
      if (!task) {
        const tasks = this.repos.tasks.listByChain(chainId);
        const allOk = tasks.length > 0 && tasks.every((t) => t.status === "ok");
        if (allOk) {
          this.repos.chains.setStatus(chainId, "completed");
          this.repos.events.append({
            type: "chain.state",
            payload: { chainId, status: "completed" },
          });
          await new ProjectDocs(this.repos, project).updateState(
            this.repos.chains.getOrThrow(chainId),
          );
          this.bus.emit("overview");
        }
        return;
      }

      const acquired = this.locks.tryAcquire(projectId, task.id);
      if (!acquired) return; // another driver holds the project, or we are at capacity

      // One task's failure stops this chain, not the loop and not the process. `runTask` does
      // more than run the agent — git, the verify gate, the managed docs — and any of those can
      // throw for reasons that have nothing to do with the next chain waiting its turn.
      let keepGoing = false;
      try {
        keepGoing = await this.runTask(project, chain, task);
      } catch (err) {
        this.taskCrashed(project, chain, task, err);
        return;
      } finally {
        this.locks.release(projectId);
      }
      if (!keepGoing) return;
    }
  }

  /**
   * A task threw instead of returning an outcome. Fail the task, pause the chain and record the
   * reason on the task's own timeline, so the failure is visible where the user is already
   * looking rather than only in the container log.
   */
  private taskCrashed(project: ProjectRow, chain: ChainRow, task: TaskRow, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      // The run row may still be open if the throw happened before the runner finished it.
      for (const run of this.repos.runs.listByTask(task.id)) {
        if (run.status !== "running" && run.status !== "waiting_human") continue;
        this.repos.runs.finish(run.id, {
          status: "error",
          exitReason: `task failed outside the run: ${detail}`,
          summary: null,
          error: detail,
        });
      }
      this.repos.tasks.setStatus(task.id, "error");
      this.repos.chains.setStatus(chain.id, "paused");
      this.repos.events.append({
        type: "task.state",
        payload: { taskId: task.id, status: "error", reason: "task failed", detail },
      });
      this.repos.events.append({
        type: "chain.state",
        payload: { chainId: chain.id, status: "paused", reason: "task failed", detail },
      });
      this.bus.emit("overview");
    } catch {
      // Nothing left to report with.
    }
    console.error(`[task:${task.id}] failed: ${detail}`);
    void this.closePhase(task.id);
  }

  /**
   * End-of-run hygiene (PE-08, DESIGN §5.2b): empty the scratch directory and report what the run
   * left untracked elsewhere. Never throws — housekeeping cannot cost a finished task.
   */
  private async sweepScratch(project: ProjectRow, runId: string): Promise<void> {
    try {
      const result = await sweep(project.path);
      if (result.error) {
        this.repos.events.append({
          runId,
          type: "scratch.sweep_failed",
          payload: { error: result.error },
        });
      } else if (result.files > 0) {
        this.repos.events.append({
          runId,
          type: "scratch.swept",
          payload: { files: result.files, bytes: result.bytes },
        });
      }
      if (result.untracked.length > 0) {
        // KB-05c: one shape of leftover is not a leftover at all — it is a knowledge base written
        // to a relative path, which landed inside the project. "3 untracked files" is true and
        // says nothing; the run that has to be repaired deserves the diagnosis.
        const misplaced = result.untracked.filter((file) => /^knowledge[\\/]/.test(file));
        const writableBase = this.repos.projectKnowledge
          .list(project.id)
          .find((row) => row.writable === 1)?.base_id;
        this.repos.events.append({
          runId,
          type: "run.untracked",
          payload: {
            count: result.untracked.length,
            paths: result.untracked,
            ...(misplaced.length
              ? {
                  misplacedKnowledge: misplaced,
                  detail:
                    `${misplaced.length} of them are under ${project.id}/knowledge/, which is a ` +
                    "folder of this project and not the shared base: a relative `knowledge/…` " +
                    "resolves inside the project" +
                    (writableBase
                      ? `. The base is ${path.join(this.config.workspace, "knowledge", writableBase)}` +
                        " — copy them there, or relaunch now that the prompt names the absolute path"
                      : ". This project has no writable base attached (KB-05)"),
                }
              : {}),
          },
        });
      }
    } catch (err) {
      console.error(`[hygiene:${project.id}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Returns true when the chain should continue with the next task. */
  private async runTask(project: ProjectRow, chain: ChainRow, task: TaskRow): Promise<boolean> {
    const docs = new ProjectDocs(this.repos, project);
    const git = new ProjectGit(project.path);
    const { config: projectConfig, pack } = await readProjectConfig(project.path);

    await docs.syncPlan(chain);
    await docs.updateState(chain);

    // The scratch directory exists before the agent needs it, including for projects created
    // before PE-08 (DESIGN §5.2b).
    await ensureScratch(project.path).catch(() => undefined);

    const result = await this.runner.run({
      project,
      task,
      projectPack: pack,
      onStderr: (line) => console.error(`[adapter:${task.id}] ${line}`),
    });
    const { runId, outcome } = result;

    this.repos.events.append({
      runId,
      type: "task.state",
      payload: { taskId: task.id, status: outcome.status },
    });

    // Hygiene before anything commits, on every outcome including failures (PE-08, §5.2b).
    await this.sweepScratch(project, runId);

    // The advisor settled the doubt: the task is queued again and will run with the decision
    // in its context (DO-02). No commit and no gate for a turn that did not finish the work.
    if (result.autoContinued) {
      this.repos.events.append({
        type: "chain.state",
        payload: {
          chainId: chain.id,
          status: "active",
          reason: `auto-continue on ${result.autoContinued.choice}`,
        },
      });
      await docs.updateState(chain);
      this.bus.emit("overview");
      return true;
    }

    if (outcome.status !== "ok") {
      // doubt keeps the chain active but waiting (§8); everything else pauses it (OR-05). One
      // exception: a chain the user aborted is already in its final state, and the aborted task's
      // outcome arrives after that decision — pausing it would erase what the user asked for
      // (§5.4).
      const current = this.repos.chains.getOrThrow(chain.id);
      if (outcome.status !== "doubt" && current.status !== "aborted") {
        this.repos.chains.setStatus(chain.id, "paused");
        this.repos.events.append({
          type: "chain.state",
          payload: { chainId: chain.id, status: "paused", reason: outcome.status },
        });
      }
      await docs.syncPlan(chain);
      await docs.updateState(this.repos.chains.getOrThrow(chain.id));
      // A doubt is not terminal: the task is waiting, not finished, so the phase stays running.
      if (outcome.status !== "doubt") await this.closePhase(task.id);
      this.bus.emit("overview");
      return false;
    }

    // Task ok: consolidate git, then the verify gate, then push policy (DESIGN §5.2).
    if (await git.isRepo()) {
      // The agent may have committed its own work (git_local is allowed), in which case
      // consolidate is a no-op. Either way the task's result is the current HEAD, so that
      // is what the run records.
      const commit = await git.consolidate(task.id, task.title);
      const finalCommit = commit.sha || (await git.head()) || null;
      if (finalCommit) {
        this.repos.runs.finish(runId, {
          status: "ok",
          exitReason: outcome.exitReason,
          summary: outcome.summary || null,
          tokensIn: outcome.tokensIn ?? null,
          tokensOut: outcome.tokensOut ?? null,
          costUsd: outcome.costUsd ?? null,
          finalCommit,
        });
      }
      if (commit.created) {
        this.repos.events.append({
          runId,
          type: "git.commit",
          payload: { sha: commit.sha, message: `feat: ${task.title} [lo:${task.id}]` },
        });
      }
    }

    const verifyCmd = task.verify_cmd ?? project.verify_cmd ?? projectConfig.verify;
    const verify = await runVerify({
      repos: this.repos,
      runId,
      cwd: project.path,
      command: verifyCmd,
    });

    if (verify.ran && verify.exitCode !== 0) {
      this.repos.tasks.setStatus(task.id, "verify_failed");
      this.repos.runs.setStatus(runId, "verify_failed", `verify exit ${verify.exitCode}`);
      this.repos.chains.setStatus(chain.id, "paused");
      this.repos.events.append({
        type: "chain.state",
        payload: { chainId: chain.id, status: "paused", reason: "verify_failed" },
      });
      await docs.syncPlan(chain);
      await docs.updateState(this.repos.chains.getOrThrow(chain.id));
      await this.closePhase(task.id);
      this.bus.emit("overview");
      return false;
    }

    if (
      project.push_policy === "auto" &&
      project.repo_remote &&
      (await git.hasRemote()) &&
      (!verify.ran || verify.exitCode === 0)
    ) {
      try {
        await git.push();
        this.repos.events.append({
          runId,
          type: "git.push",
          payload: { remote: project.repo_remote },
        });
      } catch (err) {
        // A failed push must not undo a good task: report it and keep the chain going.
        this.repos.events.append({
          runId,
          type: "system",
          payload: {
            reason: "push failed",
            detail: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    await docs.syncPlan(chain);
    await docs.updateState(chain);
    await this.closePhase(task.id);
    this.bus.emit("overview");
    return true;
  }

  /**
   * Tell the phase layer that a task reached a terminal state. A failure in the phase layer
   * must not take the chain loop down with it, so it is reported and swallowed.
   */
  private async closePhase(taskId: string): Promise<void> {
    if (!this.phaseHook) return;
    try {
      await this.phaseHook(taskId);
    } catch (err) {
      this.repos.events.append({
        type: "system",
        payload: {
          reason: "phase transition failed",
          taskId,
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /**
   * Answer an open doubt and resume the task that raised it (DO-04). Functional doubts requeue
   * the task, which then runs with the decision prepended to its prompt; permission doubts are
   * resolved by the held ACP request, which phase 6 exposes through MCP.
   */
  async answerDoubt(input: {
    doubtId: string;
    choice: string;
    note?: string;
    projectId?: string;
  }): Promise<{ ref: string; resumed: boolean; runId?: string }> {
    const answered = await this.doubts.answer(input);
    const doubt = answered.doubt;
    const task = this.repos.tasks.getOrThrow(doubt.task_id);
    const chain = this.repos.chains.getOrThrow(task.chain_id);
    const project = this.repos.projects.getOrThrow(task.project_id);

    if (doubt.kind === "permission") {
      // The run is holding the ACP response; nothing to requeue here.
      return { ref: doubt.ref, resumed: false };
    }

    if (doubt.kind === "gate") {
      // A gate blocks the next phase, not the task that produced it: the task is done and
      // must not run again (§16.2).
      const advanced = this.gateHook ? await this.gateHook(doubt, input.choice) : false;
      this.bus.emit("overview");
      return { ref: doubt.ref, resumed: advanced };
    }

    this.repos.tasks.setStatus(task.id, "queued");
    if (chain.status !== "active") this.repos.chains.setStatus(chain.id, "active");
    this.repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "active", reason: `doubt ${doubt.ref} answered` },
    });
    const started = this.tryDrive(project, this.repos.chains.getOrThrow(chain.id));
    this.bus.emit("overview");
    return { ref: doubt.ref, resumed: started };
  }

  /** Open doubts across all projects or one of them (DO-05). */
  listDoubts(projectId?: string) {
    return this.repos.doubts.listOpen(projectId);
  }

  /** Retry a blocked task: requeue it and resume the chain (OR-05). */
  retryTask(taskId: string): boolean {
    const task = this.repos.tasks.getOrThrow(taskId);
    const chain = this.repos.chains.getOrThrow(task.chain_id);
    const project = this.repos.projects.getOrThrow(task.project_id);
    this.repos.tasks.setStatus(taskId, "queued");
    if (chain.status !== "active") this.repos.chains.setStatus(chain.id, "active");
    this.repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "active", reason: `retry ${taskId}` },
    });
    return this.tryDrive(project, this.repos.chains.getOrThrow(chain.id));
  }

  /**
   * Stop the work that is actually running (OR-06, OR-09, DESIGN §5.4): cancel the ACP turn, end
   * the adapter process, and release any permission gate the run was holding. The session's own
   * outcome becomes `aborted` and travels the ordinary path, so the run row, the task status and
   * the hygiene sweep all happen exactly as they do for any other ending.
   *
   * `stopped: false` means there was nothing live to stop — said plainly rather than reported as
   * a success. A row still claiming `running` with no session behind it is reconciled here.
   */
  async stopRun(
    runId: string,
    reason = "stopped by request",
  ): Promise<{ runId: string; stopped: boolean; doubtsClosed: string[]; reconciled: boolean }> {
    const handle = this.live.get(runId);
    const doubtsClosed = await this.doubts.cancelForRun(runId, reason);

    if (!handle) {
      const run = this.repos.runs.get(runId);
      const stale = run && (run.status === "running" || run.status === "waiting_human");
      if (stale) {
        this.repos.runs.setStatus(runId, "interrupted", reason);
        this.repos.events.append({
          runId,
          type: "run.state",
          payload: { status: "interrupted", reason: `${reason}: no live session` },
        });
        const task = this.repos.tasks.get(run.task_id);
        if (task && task.status === "running") {
          this.repos.tasks.setStatus(task.id, "interrupted");
        }
        this.bus.emit("overview");
      }
      return { runId, stopped: false, doubtsClosed, reconciled: Boolean(stale) };
    }

    this.repos.events.append({
      runId,
      type: "system",
      payload: { reason, acpSession: handle.acpSession() ?? null },
    });
    await handle.abort();
    this.bus.emit("overview");
    return { runId, stopped: true, doubtsClosed, reconciled: false };
  }

  /**
   * Abort a chain (OR-06, OR-09): the queued tasks are dropped and the run in flight is stopped
   * too, unless `letCurrentFinish` is set. Dropping the queue while the agent kept typing was the
   * old behaviour and the surprising one; finishing the current task is now the opt-in.
   */
  async abortChain(
    chainId: string,
    options: { letCurrentFinish?: boolean; reason?: string } = {},
  ): Promise<{ aborted: string[]; stopped: string[] }> {
    const chain = this.repos.chains.getOrThrow(chainId);
    this.repos.chains.setStatus(chain.id, "aborted");
    const aborted: string[] = [];
    for (const task of this.repos.tasks.listByChain(chain.id)) {
      if (task.status === "queued") {
        this.repos.tasks.setStatus(task.id, "aborted");
        aborted.push(task.id);
      }
    }

    const stopped: string[] = [];
    if (!options.letCurrentFinish) {
      for (const handle of this.live.forChain(chain.id)) {
        const result = await this.stopRun(handle.runId, options.reason ?? "chain aborted");
        if (result.stopped) stopped.push(handle.runId);
      }
    }

    this.repos.events.append({
      type: "chain.state",
      payload: {
        chainId: chain.id,
        status: "aborted",
        tasks: aborted.length,
        stopped: stopped.length,
      },
    });
    this.bus.emit("overview");
    return { aborted, stopped };
  }

  /**
   * Put a paused chain back to work (OR-05). Nothing is retried silently — this is only ever the
   * answer to someone asking for it — but until now there was no way to ask: a chain paused by a
   * container restart or a failed task was a dead end, with its tasks stuck `interrupted` and no
   * action anywhere that could move them. Tasks that did not finish are queued again; tasks that
   * ended `ok` are left alone, so resuming never redoes completed work.
   */
  resumeChain(chainId: string): { chainId: string; requeued: string[]; started: boolean } {
    const chain = this.repos.chains.getOrThrow(chainId);
    if (chain.status === "active") {
      return { chainId: chain.id, requeued: [], started: this.driving.has(chain.id) };
    }
    if (chain.status === "completed") throw new Error(`chain ${chain.id} is already completed`);

    const requeued: string[] = [];
    for (const task of this.repos.tasks.listByChain(chain.id)) {
      if (task.status === "ok" || task.status === "queued" || task.status === "running") continue;
      this.repos.tasks.setStatus(task.id, "queued");
      requeued.push(task.id);
      this.repos.events.append({
        type: "task.state",
        payload: { taskId: task.id, status: "queued", reason: "chain resumed" },
      });
    }

    this.repos.chains.setStatus(chain.id, "active");
    this.repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "active", reason: "resumed", tasks: requeued.length },
    });
    this.bus.emit("overview");

    const project = this.repos.projects.getOrThrow(chain.project_id);
    const started = this.tryDrive(project, this.repos.chains.getOrThrow(chain.id));
    return { chainId: chain.id, requeued, started };
  }
}
