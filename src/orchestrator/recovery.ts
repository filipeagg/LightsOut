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
};

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
    // The phase row is what the panel actually shows. Leaving it `running` while its task is
    // interrupted made the project view state something untrue: a phase marked running with no
    // run in flight and no way to tell that anything had gone wrong. It goes back to `pending`,
    // which is where it really is — it has to run again — rather than adding an `interrupted`
    // phase status for a distinction the `phase.state` event already records.
    const phase = repos.phases.getByTask(task.id);
    if (phase && phase.status === "running") {
      repos.phases.setStatus(phase.id, "pending");
      repos.events.append({
        runId: run.id,
        type: "phase.state",
        payload: { phaseId: phase.id, ref: phase.phase_id, status: "pending", reason },
      });
    }

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

  return { runs: interrupted.length, chainsPaused: [...chainsPaused] };
}
