/**
 * Retiring a project (PM-08): the archive flag, and the hand-written cascade behind a permanent
 * delete. The cascade is the part worth testing — the schema declares the references but no
 * `ON DELETE CASCADE`, and `foreign_keys` is on, so a missing DELETE is not a leak, it is a
 * failed transaction that leaves the project standing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { isKnownModel, defaultModel, ENGINE_MODELS } from "../src/agents/models.js";

let db: Db;
let repos: Repos;

/** A project with one of everything that points at it, directly or through a run. */
function seedFullProject(id: string): { taskId: string; runId: string } {
  repos.projects.create({ id, name: id, path: `/workspace/projects/${id}` });
  const chain = repos.chains.create({ projectId: id, title: "chain" });
  const task = repos.tasks.create({
    chainId: chain.id,
    projectId: id,
    title: "task",
    spec: "do the thing",
    agentId: "builder",
    level: "quick",
  });
  const run = repos.runs.start({ taskId: task.id, engine: "claude", model: "sonnet" });

  repos.events.append({ runId: run.id, type: "run.state", payload: { status: "running" } });
  repos.audit.record({
    runId: run.id,
    actionClass: "fs.write",
    detail: { path: "src/a.ts" },
    ruleSource: "project",
    verdict: "allow",
    latencyMs: 2,
  });
  const doubt = repos.doubts.open({
    projectId: id,
    taskId: task.id,
    kind: "functional",
    context: "ambiguous",
    blocks: "the next task",
    options: [{ id: "A", text: "x" }],
  });
  repos.decisions.record({
    projectId: id,
    taskId: task.id,
    doubtId: doubt.id,
    kind: "human",
    question: "which?",
    choice: "A",
  });
  repos.phases.create({
    projectId: id,
    position: 0,
    phaseId: "shape",
    title: "Shape it",
    agentId: "builder",
    instructions: "shape the request",
  });
  repos.projectKnowledge.attach({
    projectId: id,
    baseId: "legacy-core",
    kind: "technical",
    writable: false,
  });
  // The three that migrations 5, 9 and 10 added and nobody added to the cascade. Seeded here so
  // "one of everything that points at it" is true again, not just true when it was written.
  repos.areas.add({ projectId: id, path: "sources/legacy-core", addedBy: "panel" });
  db.prepare(
    `INSERT INTO toolchain_grants (id, project_id, manager, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`tg-${id}`, id, "npm", "panel", new Date().toISOString());
  db.prepare(
    `INSERT INTO previews
       (id, project_id, port, command, normalised, cwd, log_path, status, started_by, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', 'panel', ?)`,
  ).run(
    `pv-${id}`,
    id,
    id === "doomed" ? 5170 : 5171,
    "npm run dev",
    "npm run dev",
    `/workspace/projects/${id}`,
    `/workspace/projects/${id}/.lightsout/tmp/preview.log`,
    new Date().toISOString(),
  );
  return { taskId: task.id, runId: run.id };
}

/**
 * Every table that holds rows belonging to a project, read from the schema rather than listed.
 *
 * The point of doing it this way: `remove()` is a cascade typed out by hand, three migrations
 * added tables without touching it, and the failure surfaced as `FOREIGN KEY constraint failed`
 * on a delete the user could not explain. A list written here would have gone stale exactly as
 * the one in the repository did.
 */
function tablesOwnedByAProject(): string[] {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
  return tables.filter((table) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === "project_id",
    ),
  );
}

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

describe("archiving a project (PM-08)", () => {
  it("hides it from the default list and comes back", () => {
    const id = "demo";
    repos.projects.create({ id, name: id, path: `/workspace/projects/${id}` });

    repos.projects.update(id, { archived: true });
    expect(repos.projects.list().map((p) => p.id)).toEqual([]);
    expect(repos.projects.list({ includeArchived: true }).map((p) => p.id)).toEqual([id]);
    expect(repos.projects.getOrThrow(id).archived).toBe(1);

    repos.projects.update(id, { archived: false });
    expect(repos.projects.list().map((p) => p.id)).toEqual([id]);
  });
});

describe("deleting a project for good (PM-08)", () => {
  it("empties every table that holds rows for it, whatever a migration added", () => {
    // Read from the schema, so a table added later cannot quietly stay out of the cascade.
    const owned = tablesOwnedByAProject();
    seedFullProject("doomed");
    seedFullProject("survivor");

    // The seed has to be honest about what it covers, or the assertion below proves nothing.
    const seeded = owned.filter(
      (t) =>
        (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE project_id = ?`).get("doomed") as {
          n: number;
        }).n > 0,
    );
    expect(seeded.sort(), "seedFullProject does not cover every project-owned table").toEqual(
      owned.sort(),
    );

    expect(() => repos.projects.remove("doomed")).not.toThrow();

    for (const table of owned) {
      const row = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id = ?`).get("doomed");
      expect((row as { n: number }).n, `${table} still holds rows for the deleted project`).toBe(0);
      const kept = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id = ?`).get("survivor");
      expect((kept as { n: number }).n, `${table} lost the other project's rows`).toBeGreaterThan(0);
    }
  });

  it("removes the project and everything hanging off it", () => {
    const { taskId, runId } = seedFullProject("doomed");
    const count = (sql: string, ...args: unknown[]): number =>
      (db.prepare(sql).get(...args) as { n: number }).n;

    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?", "doomed")).toBe(1);

    repos.projects.remove("doomed");

    expect(repos.projects.get("doomed")).toBeUndefined();
    for (const table of ["chains", "tasks", "doubts", "decisions", "project_phases", "project_knowledge"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, "doomed")).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?", taskId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM permission_audit WHERE run_id = ?", runId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM events WHERE run_id = ?", runId)).toBe(0);

    // The foreign keys are on: if the cascade had missed a table the delete would have thrown,
    // but check explicitly so a future reordering cannot leave a dangling row behind.
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("leaves other projects and the system events alone", () => {
    seedFullProject("doomed");
    const survivor = seedFullProject("keeper");
    repos.events.append({ type: "system.auth", payload: { engine: "codex" } });

    repos.projects.remove("doomed");

    expect(repos.projects.get("keeper")).toBeDefined();
    expect(repos.runs.getOrThrow(survivor.runId).id).toBe(survivor.runId);
    expect(repos.events.listAfter(0).some((e) => e.type === "system.auth")).toBe(true);
  });
});

describe("the model catalog (AP-08)", () => {
  it("offers an alias first and knows what each engine accepts", () => {
    expect(defaultModel("claude")).toBe("sonnet");
    expect(isKnownModel("claude", "claude-sonnet-4-5")).toBe(true);
    expect(isKnownModel("claude", "gpt-5-codex")).toBe(false);
    expect(isKnownModel("codex", "gpt-5-codex")).toBe(true);
    expect(isKnownModel("codex", "sonnet")).toBe(false);
  });

  it("only lists reasoning levels the profile schema accepts", () => {
    for (const engine of ["claude", "codex"] as const) {
      expect(ENGINE_MODELS[engine].reasoning).toEqual(["minimal", "low", "medium", "high"]);
    }
  });

  it("covers the model every builtin profile ships with", () => {
    // A builtin whose model is not in the catalog would be a profile the editor cannot save.
    expect(isKnownModel("claude", "claude-sonnet-4-5")).toBe(true);
    expect(isKnownModel("codex", "gpt-5-codex")).toBe(true);
  });
});
