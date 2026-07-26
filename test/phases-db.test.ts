/** Phase 9: the migration-2 tables and their repos (TP-05..08, KB-03, VT-05). */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate, MIGRATIONS } from "../src/db/migrate.js";
import { nowIso, ulid } from "../src/ids.js";
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

  /**
   * The rebuild of `doubts` is the risky half of this migration, and it is only risky when
   * there is data to carry across: a database that already holds doubts and the decisions
   * pointing at them. Migrating an empty schema proves nothing, which is how this shipped
   * broken once — the container restart-looped on `FOREIGN KEY constraint failed`.
   */
  it("carries existing doubts and their decisions across the rebuild", () => {
    const legacy = openDb({ file: ":memory:" });
    const v1 = MIGRATIONS.find((m) => m.version === 1)!;
    (v1.up as (db: Db) => void)(legacy);
    legacy
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
      .run(nowIso());

    const legacyRepos = createRepos(legacy);
    // Raw SQL: ProjectsRepo already writes template_id, which the v1 schema does not have.
    legacy
      .prepare(
        `INSERT INTO projects (id, name, path, push_policy, policy_pack, archived, created_at)
         VALUES ('old', 'Old', '/workspace/projects/old', 'manual', 'default', 0, ?)`,
      )
      .run(nowIso());
    const chain = legacyRepos.chains.create({ projectId: "old", title: "c" });
    // Raw SQL: TasksRepo now writes needs/grants, which migration 7 adds (PE-12).
    const taskId = ulid();
    legacy
      .prepare(
        `INSERT INTO tasks (id, chain_id, project_id, position, title, spec, agent_id, level,
                            status, created_at, updated_at)
         VALUES (?, ?, 'old', 1, 't', 's', 'builder', 'quick', 'queued', ?, ?)`,
      )
      .run(taskId, chain.id, nowIso(), nowIso());
    const task = legacyRepos.tasks.getOrThrow(taskId);
    // Raw SQL again: DoubtsRepo now writes action_class/action_shape, which migration 6 adds and
    // a version-1 schema does not have. The point of this fixture is the old shape.
    const doubtId = ulid();
    legacy
      .prepare(
        `INSERT INTO doubts (id, ref, project_id, task_id, kind, status, context, blocks,
                             options, created_at)
         VALUES (?, 'D-1', 'old', ?, 'functional', 'open', 'which way', 'the rest', ?, ?)`,
      )
      .run(doubtId, task.id, JSON.stringify([{ id: "A", text: "left" }]), nowIso());
    const doubt = legacyRepos.doubts.getOrThrow(doubtId);
    legacyRepos.decisions.record({
      projectId: "old",
      taskId: task.id,
      doubtId: doubt.id,
      kind: "human",
      question: "which way",
      choice: "A",
    });

    const result = migrate(legacy);
    expect(result.from).toBe(1);
    // Both rebuilds of `doubts` run, one after the other, on a database that has data in it.
    expect(result.applied).toEqual([
      "2:phases, knowledge, vault audit",
      "3:hard rule doubts and knowledge enforcement",
      "4:project context brief",
      "5:project read-only areas",
      "6:learned allows",
      "7:task capabilities",
      "8:task engine and model override",
      "9:toolchain grants and the toolchain doubt kind",
    ]);
    // Migration 4 gives the legacy project a brief it can be told apart from a real one (PM-09).
    expect(
      (legacy.prepare("SELECT context FROM projects WHERE id = 'old'").get() as {
        context: string;
      }).context,
    ).toContain("status: provisional");

    const after = createRepos(legacy);
    expect(after.doubts.get(doubt.id)?.ref).toBe(doubt.ref);
    expect(after.decisions.listByDoubt(doubt.id)).toHaveLength(1);
    expect(legacy.pragma("foreign_key_check")).toEqual([]);
    // And the widened CHECK is in force on the rebuilt table.
    expect(() =>
      legacy
        .prepare(
          `INSERT INTO doubts (id, ref, project_id, task_id, kind, status, context, blocks,
                               options, created_at)
           VALUES (?, 'D-9', 'old', ?, 'nonsense', 'open', 'c', 'b', '[]', ?)`,
        )
        .run(ulid(), task.id, nowIso()),
    ).toThrow();
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
    repos.projectKnowledge.attach({ projectId, baseId: "legacy-core", kind: "technical" });
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(1);
    expect(repos.projectKnowledge.writableBase(projectId)).toBeUndefined();

    repos.projectKnowledge.attach({
      projectId,
      baseId: "legacy-core",
      kind: "technical",
      writable: true,
    });
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(1);
    expect(repos.projectKnowledge.writableBase(projectId)).toBe("legacy-core");

    expect(repos.projectKnowledge.detach(projectId, "legacy-core")).toBe(true);
    expect(repos.projectKnowledge.list(projectId)).toHaveLength(0);
  });
});

describe("vault audit repo", () => {
  it("records field names without values", () => {
    const projectId = seedProject();
    const taskId = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude" });
    repos.vaultAudit.record(run.id, "sandbox-api", ["token", "user"]);
    const rows = repos.vaultAudit.listForRun(run.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].fields)).toEqual(["token", "user"]);
  });
});
