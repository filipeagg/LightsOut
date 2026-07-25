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
import type { ChainRow, ProjectRow, TaskLevel, TaskRow } from "../db/types.js";
import { TaskRunner, type HealthInvalidator } from "../acp/runner.js";
import { ProjectGit } from "../projects/git.js";
import { ProjectDocs } from "../projects/docs.js";
import { readProjectConfig } from "../projects/config.js";
import { runVerify } from "./verify.js";
import { RunLocks } from "./locks.js";
import type { RunTaskInput, RunTaskResult } from "../acp/runner.js";
import { DoubtService } from "./doubts.js";

/** The one seam the chain loop needs from the ACP layer; injectable for tests. */
export type TaskRunnerLike = { run: (input: RunTaskInput) => Promise<RunTaskResult> };

export type LaunchTaskInput = {
  projectId: string;
  title: string;
  spec: string;
  agentId: string;
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
  ) {
    this.locks = new RunLocks(config.maxParallel);
    this.doubts = doubts ?? new DoubtService(config, repos, bus, agents);
    this.runner =
      runner ?? new TaskRunner(config, repos, bus, agents, this.doubts, health);
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
        spec: task.spec,
        agentId: task.agentId,
        ...(task.level ? { level: task.level } : {}),
        ...(task.verifyCmd !== undefined ? { verifyCmd: task.verifyCmd } : {}),
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
      spec: input.spec,
      agentId: input.agentId,
      ...(input.level ? { level: input.level } : {}),
      ...(input.verifyCmd !== undefined ? { verifyCmd: input.verifyCmd } : {}),
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

    const driver = this.drive(project.id, chain.id).finally(() => {
      this.driving.delete(chain.id);
    });
    this.driving.set(chain.id, driver);
    return true;
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

      let keepGoing = false;
      try {
        keepGoing = await this.runTask(project, chain, task);
      } finally {
        this.locks.release(projectId);
      }
      if (!keepGoing) return;
    }
  }

  /** Returns true when the chain should continue with the next task. */
  private async runTask(project: ProjectRow, chain: ChainRow, task: TaskRow): Promise<boolean> {
    const docs = new ProjectDocs(this.repos, project);
    const git = new ProjectGit(project.path);
    const { config: projectConfig, pack } = await readProjectConfig(project.path);

    await docs.syncPlan(chain);
    await docs.updateState(chain);

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
      // doubt keeps the chain active but waiting (§8); everything else pauses it (OR-05).
      if (outcome.status !== "doubt") {
        this.repos.chains.setStatus(chain.id, "paused");
        this.repos.events.append({
          type: "chain.state",
          payload: { chainId: chain.id, status: "paused", reason: outcome.status },
        });
      }
      await docs.syncPlan(chain);
      await docs.updateState(this.repos.chains.getOrThrow(chain.id));
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
    this.bus.emit("overview");
    return true;
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

  /** Abort a chain: queued tasks are dropped, the running one is left to finish (OR-06). */
  abortChain(chainId: string): string[] {
    const chain = this.repos.chains.getOrThrow(chainId);
    this.repos.chains.setStatus(chain.id, "aborted");
    const aborted: string[] = [];
    for (const task of this.repos.tasks.listByChain(chain.id)) {
      if (task.status === "queued") {
        this.repos.tasks.setStatus(task.id, "aborted");
        aborted.push(task.id);
      }
    }
    this.repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "aborted", tasks: aborted.length },
    });
    this.bus.emit("overview");
    return aborted;
  }
}
