/**
 * A phase is `running` while its task is, and a task waiting on a doubt is waiting, not dead.
 *
 * The bug: a restart while a doubt was open demoted the phase to `pending`; answering the doubt
 * requeued the task and nothing put the phase back. The panel then showed `pending` with a run
 * visibly in flight and offered a Launch button for work already running.
 */
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos } from "../src/db/repos/index.js";
import { recoverInterrupted } from "../src/orchestrator/recovery.js";
import type { TaskStatus } from "../src/db/types.js";

function fixture(taskStatus: TaskStatus) {
  const db = openDb({ file: ":memory:" });
  migrate(db);
  const repos = createRepos(db);

  const project = repos.projects.create({
    id: "p",
    name: "P",
    path: "/workspace/projects/p",
    context: "goal: exercise the phase invariant",
  });
  const chain = repos.chains.create({ projectId: project.id, title: "C" });
  const task = repos.tasks.create({
    chainId: chain.id,
    projectId: project.id,
    position: 1,
    title: "T",
    spec: "s",
    agentId: "builder",
    level: "quick",
  });
  repos.tasks.setStatus(task.id, taskStatus);

  const phase = repos.phases.create({
    projectId: project.id,
    position: 0,
    phaseId: "probe",
    title: "Probe",
    agentId: "contract-prober",
    instructions: "i",
  });
  repos.phases.markRunning(phase.id, task.id);

  return { repos, phaseId: phase.id };
}

const statusAfterRecovery = (taskStatus: TaskStatus) => {
  const { repos, phaseId } = fixture(taskStatus);
  recoverInterrupted(repos, "boot");
  return repos.phases.getOrThrow(phaseId).status;
};

describe("a phase follows its task (§16.2)", () => {
  it("keeps a phase running while its task waits on a doubt", () => {
    // The whole point: the orchestrator does not close a phase on a doubt, so recovery must
    // not undo that just because the container restarted in the meantime.
    expect(statusAfterRecovery("doubt")).toBe("running");
  });

  it("keeps it running while the task runs or waits in the queue", () => {
    expect(statusAfterRecovery("running")).toBe("running");
    expect(statusAfterRecovery("queued")).toBe("running");
  });

  it("still demotes a phase whose task really is finished or dead", () => {
    for (const status of ["ok", "error", "aborted", "interrupted", "timeout"] as TaskStatus[]) {
      expect(statusAfterRecovery(status), status).toBe("pending");
    }
  });

  it("markRunning puts a phase back, which is what answering a doubt needs", () => {
    const { repos, phaseId } = fixture("doubt");
    repos.phases.setStatus(phaseId, "pending");
    expect(repos.phases.getOrThrow(phaseId).status).toBe("pending");

    const phase = repos.phases.getOrThrow(phaseId);
    repos.phases.markRunning(phase.id, phase.task_id!);
    const back = repos.phases.getOrThrow(phaseId);
    expect(back.status).toBe("running");
    expect(back.ended_at).toBeNull();
  });
});
