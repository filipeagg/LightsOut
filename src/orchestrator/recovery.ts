/**
 * Boot-time recovery (RT-07, OR-05, DESIGN §11.2).
 * Interrupted work is surfaced, never silently retried: runs left `running` or
 * `waiting_human` become `interrupted` with their ACP session recorded for a manual resume,
 * their tasks follow, and the owning chains pause.
 */
import type { Repos } from "../db/repos/index.js";

export type RecoveryReport = {
  runs: number;
  chainsPaused: string[];
  /** Phase rows left claiming to be running by this or any earlier restart. */
  phasesReconciled: string[];
};

/**
 * Enforce the invariant the panel depends on: a phase is `running` only while its task is.
 *
 * Doing this only for the runs a single recovery pass interrupts is not enough — a row left
 * `running` by an earlier restart is never looked at again, and the panel goes on reporting a
 * phase as working with no run in flight for as long as the project lives. So every phase is
 * reconciled at boot, whatever left it inconsistent.
 */
function reconcilePhases(repos: Repos, reason: string): string[] {
  const fixed: string[] = [];
  for (const project of repos.projects.list({ includeArchived: true })) {
    for (const phase of repos.phases.list(project.id)) {
      if (phase.status !== "running") continue;
      const task = phase.task_id ? repos.tasks.get(phase.task_id) : undefined;
      if (task && (task.status === "running" || task.status === "queued")) continue;
      repos.phases.setStatus(phase.id, "pending");
      repos.events.append({
        type: "phase.state",
        payload: {
          phaseId: phase.id,
          ref: phase.phase_id,
          status: "pending",
          reason: `${reason}: its task is ${task?.status ?? "gone"}`,
        },
      });
      fixed.push(phase.id);
    }
  }
  return fixed;
}

export function recoverInterrupted(repos: Repos, reason = "container restart"): RecoveryReport {
  const interrupted = repos.runs.markInterrupted(reason);
  const chainsPaused = new Set<string>();

  for (const run of interrupted) {
    repos.events.append({
      runId: run.id,
      type: "run.state",
      payload: { status: "interrupted", reason, acpSession: run.acp_session },
    });
    const task = repos.tasks.get(run.task_id);
    if (!task) continue;
    repos.tasks.setStatus(task.id, "interrupted");
    repos.events.append({
      runId: run.id,
      type: "task.state",
      payload: { taskId: task.id, status: "interrupted" },
    });
    const chain = repos.chains.get(task.chain_id);
    if (chain && chain.status === "active") {
      repos.chains.setStatus(chain.id, "paused");
      repos.events.append({
        type: "chain.state",
        payload: { chainId: chain.id, status: "paused", reason },
      });
      chainsPaused.add(chain.id);
    }
  }

  // After the runs, because interrupting a task is what makes its phase inconsistent — and the
  // pass also catches rows an earlier restart left behind, which is how a phase can read
  // `running` on a project whose run was marked interrupted long ago.
  const phasesReconciled = reconcilePhases(repos, reason);

  return { runs: interrupted.length, chainsPaused: [...chainsPaused], phasesReconciled };
}
