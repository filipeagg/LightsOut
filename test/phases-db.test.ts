/** Phase 9: the migration-2 tables and their repos (TP-05..08, KB-03, VT-05). */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";

let db: Db;
let repos: Repos;

function seedProject(id = "demo"): string {
  repos.projects.create({
    id,
    name: id,
    path: `/workspace/projects/${id}`,
    templateId: "full-development",
  });
  return id;
}

function seedTask(projectId: string): string {
  const chain = repos.chains.create({ projectId, title: "chain" });
  return repos.tasks.create({
    chainId: chain.id,
    projectId,
    title: "task",
    spec: "spec",
    agentId: "builder",
    level: "quick",
  }).id;
}

function seedPhases(projectId: string, refs: string[]): void {
  refs.forEach((ref, index) => {
    repos.phases.create({
      projectId,
      position: index,
      phaseId: ref,
      title: ref,
      agentId: "builder",
      instructions: `do ${ref}`,
    });
  });
}

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

describe("migration 2", () => {
  it("keeps template_id on projects", () => {
    const id = seedProject();
    expect(repos.projects.getOrThrow(id).template_id).toBe("full-development");
  });

  it("accepts the gate doubt kind and preserves existing doubts", () => {
    const projectId = seedProject();
    const taskId = seedTask(projectId);
    const doubt = repos.doubts.open({
      projectId,
      taskId,
      kind: "gate",
      context: "phase done",
      blocks: "the next phase",
      options: [
        { id: "A", text: "continue" },
        { id: "B", text: "stop here" },
      ],
    });
    expect(repos.doubts.get(doubt.id)?.kind).toBe("gate");
  });
});

describe("phases repo", () => {
  it("orders phases and finds the next pending one", () => {
    const projectId = seedProject();
    seedPhases(projectId, ["shape", "plan", "build"]);
    expect(repos.phases.list(projectId).map((p) => p.phase_id)).toEqual([
      "shape",
      "plan",
      "build",
    ]);
    expect(repos.phases.nextPending(projectId)?.phase_id).toBe("shape");
  });

  it("shifts positions when an ad-hoc phase is inserted", () => {
    const projectId = seedProject();
    seedPhases(projectId, ["shape", "plan", "build"]);
    repos.phases.insertAt({
      projectId,
      position: 1,
      phaseId: "adhoc-1",
      title: "extra",
      agentId: "builder",
      instructions: "squeeze in",
    });
    expect(repos.phases.list(projectId).map((p) => p.phase_id)).toEqual([
      "shape",
      "adhoc-1",
      "plan",
      "build",
    ]);
    expect(repos.phases.adhocCount(projectId)).toBe(1);
  });

  it("tracks a phase across running, done and relaunch", () => {
    const projectId = seedProject();
    seedPhases(projectId, ["build"]);
    const phase = repos.phases.getByRef(projectId, "build")!;
    const taskId = seedTask(projectId);

    const running = repos.phases.markRunning(phase.id, taskId);
    expect(running.status).toBe("running");
    expect(running.started_at).toBeTruthy();
    expect(repos.phases.getByTask(taskId)?.id).toBe(phase.id);
    expect(repos.phases.running(projectId)?.id).toBe(phase.id);

    const done = repos.phases.setStatus(phase.id, "done");
    expect(done.status).toBe("done");
    expect(done.ended_at).toBeTruthy();
    expect(repos.phases.nextPending(projectId)).toBeUndefined();
  });

  it("refuses two phases at the same position", () => {
    const projectId = seedProject();
    seedPhases(projectId, ["a"]);
    expect(() =>
      repos.phases.create({
        projectId,
        position: 0,
        phaseId: "b",
        title: "b",
        agentId: "builder",
        instructions: "b",
      }),
    ).toThrow();
  });
});

describe("project knowledge repo", () => {
  it("attaches, re-attaches and detaches a base", () => {
    const projectId = seedProject();
    repos.projectKnowledge.attach({ projectId, baseId: "erpagro", kind: "technical" });
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(1);
    expect(repos.projectKnowledge.writableBase(projectId)).toBeUndefined();

    repos.projectKnowledge.attach({
      projectId,
      baseId: "erpagro",
      kind: "technical",
      writable: true,
    });
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(1);
    expect(repos.projectKnowledge.writableBase(projectId)).toBe("erpagro");

    expect(repos.projectKnowledge.detach(projectId, "erpagro")).toBe(true);
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(0);
  });
});

describe("vault audit repo", () => {
  it("records field names without values", () => {
    const projectId = seedProject();
    const taskId = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude" });
    repos.vaultAudit.record(run.id, "erpagro-sandbox", ["token", "user"]);
    const rows = repos.vaultAudit.listForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].fields)).toEqual(["token", "user"]);
  });
});
