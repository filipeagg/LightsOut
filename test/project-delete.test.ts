/**
 * Retiring a project (PM-08): the archive flag, and the hand-written cascade behind a permanent
 * delete. The cascade is the part worth testing — the schema declares the references but no
 * `ON DELETE CASCADE`, and `foreign_keys` is on, so a missing DELETE is not a leak, it is a
 * failed transaction that leaves the project standing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ENGINE_IDS,
  catalogSource,
  defaultModel,
  isKnownModel,
  isKnownReasoning,
  modelRejection,
  publishCatalog,
  unpublishCatalog,
} from "../src/agents/models.js";
import { readSelects } from "../src/agents/catalog.js";
import { validateProfileChoice } from "../src/agents/effective.js";
import type { AgentProfile } from "../src/agents/schema.js";

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
  // TR-01, migration 15: a trigger belonging to this project.
  repos.triggers.create({
    projectId: id,
    name: "daily",
    cron: "0 7 * * *",
    agentId: "builder",
    request: "do the daily thing",
    expects: "the daily thing done",
    createdBy: "panel",
  });
  // SR-09, migration 14: a correction left for a run of this project.
  repos.runNotes.add({
    runId: run.id,
    projectId: id,
    note: "use the other endpoint",
    createdBy: "panel",
  });
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

describe("the model catalog (AP-08, DESIGN 5.6)", () => {
  afterEach(() => unpublishCatalog());

  it("falls back when no engine has answered, and says that is what it is doing", () => {
    unpublishCatalog();
    expect(catalogSource("claude")).toBe("fallback");
    expect(isKnownModel("claude", "sonnet")).toBe(true);
    // The rejection admits the list is a guess, so nobody reads it as the account's real catalog.
    expect(modelRejection("claude", "nope")).toContain("fallback");
  });

  it("prefers what the engine said, over anything written here by hand", () => {
    publishCatalog("claude", {
      models: ["default", "opus[1m]", "sonnet"],
      reasoning: ["default", "low", "high"],
      currentModel: "default",
      currentReasoning: "default",
    });
    expect(catalogSource("claude")).toBe("engine");
    expect(isKnownModel("claude", "opus[1m]")).toBe(true);
    // In the fallback list and not in the engine's: the engine wins, which is the whole point.
    expect(isKnownModel("claude", "haiku")).toBe(false);
    expect(modelRejection("claude", "haiku")).not.toContain("fallback");
    // A new profile starts on what the engine is actually on, not on our first table entry.
    expect(defaultModel("claude")).toBe("default");
  });

  it("keeps reasoning levels per engine, because the two disagree", () => {
    // Measured against the real adapters: Claude has `default` and no `ultra`, Codex the reverse,
    // and neither has ever accepted `minimal`, which the old global list offered.
    expect(isKnownReasoning("claude", "default")).toBe(true);
    expect(isKnownReasoning("claude", "ultra")).toBe(false);
    expect(isKnownReasoning("codex", "ultra")).toBe(true);
    expect(isKnownReasoning("codex", "default")).toBe(false);
    for (const engine of ENGINE_IDS) {
      expect(isKnownReasoning(engine, "minimal")).toBe(false);
    }
  });

  it("reports a profile whose model the account does not offer, without rewriting it (AP-01)", () => {
    publishCatalog("codex", {
      models: ["gpt-5.6-sol"],
      reasoning: ["low", "medium", "high"],
      currentModel: "gpt-5.6-sol",
      currentReasoning: "medium",
    });
    const stale = {
      id: "market-gatherer",
      name: "Gatherer",
      engine: "codex",
      model: "o4-mini",
      reasoning: "low",
    } as AgentProfile;
    const problem = validateProfileChoice(stale);
    expect(problem).toContain("o4-mini");
    expect(problem).toContain("gpt-5.6-sol");
    // The profile object is untouched: the workspace file stays the source of truth.
    expect(stale.model).toBe("o4-mini");
  });
});

describe("reading the engine's own selects (DESIGN 5.6)", () => {
  const configOptions = [
    { id: "mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default" }] },
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet" }, { value: "haiku" }],
    },
    {
      // Codex calls it `reasoning_effort`, Claude calls it `effort`. Matching by id would find
      // one adapter and miss the other, which is why the category is what is matched.
      id: "reasoning_effort",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
    },
  ];

  it("finds both selects by category and keeps the adapter's own id for setting them", () => {
    const selects = readSelects(configOptions);
    expect(selects.model).toEqual({ id: "model", values: ["sonnet", "haiku"], current: "sonnet" });
    expect(selects.reasoning?.id).toBe("reasoning_effort");
    expect(selects.reasoning?.values).toContain("high");
  });

  it("answers null rather than guessing when the adapter offers nothing usable", () => {
    expect(readSelects(undefined).model).toBeNull();
    expect(readSelects([]).reasoning).toBeNull();
    // Present but empty, or not a select: neither is a catalog.
    expect(readSelects([{ id: "model", category: "model", type: "select", options: [] }]).model).toBeNull();
    expect(
      readSelects([{ id: "model", category: "model", type: "text", currentValue: "x" }]).model,
    ).toBeNull();
  });
});

describe("what the builtin library is allowed to pin (DESIGN 5.6)", () => {
  // A builtin is distributed to accounts we know nothing about. A family alias survives a refresh;
  // a pinned version is a profile that cannot run on somebody else's account.
  const PORTABLE = new Set(["sonnet", "haiku", "opus", "fable"]);

  it("names a family alias or nothing at all", () => {
    const dir = path.join(process.cwd(), "builtin", "agents");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const model = /^model:\s*(\S+)\s*$/m.exec(readFileSync(path.join(dir, file), "utf8"))?.[1];
      if (model === undefined) continue;
      expect(PORTABLE.has(model), `${file} pins "${model}"`).toBe(true);
    }
  });
});
