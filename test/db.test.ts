/** Phase 2 gate: migrations, pragmas and every repository (DB-01..03). */
import { describe, expect, it, beforeEach } from "vitest";
import { checkDatabase, openDb, transaction, type Db } from "../src/db/db.js";
import { migrate, MIGRATIONS } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { slugify, ulid } from "../src/ids.js";

let db: Db;
let repos: Repos;

function seedProject(id = "demo"): string {
  repos.projects.create({ id, name: id, path: `/workspace/projects/${id}` });
  return id;
}

function seedTask(projectId: string): { chainId: string; taskId: string } {
  const chain = repos.chains.create({ projectId, title: "chain" });
  const task = repos.tasks.create({
    chainId: chain.id,
    projectId,
    title: "task",
    spec: "do the thing",
    agentId: "builder",
    level: "quick",
  });
  return { chainId: chain.id, taskId: task.id };
}

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

describe("migrations", () => {
  it("applies version 1 once and is idempotent", () => {
    const fresh = openDb({ file: ":memory:" });
    const first = migrate(fresh);
    expect(first.from).toBe(0);
    expect(first.to).toBe(MIGRATIONS.length);
    expect(first.applied).toHaveLength(MIGRATIONS.length);

    const second = migrate(fresh);
    expect(second.applied).toHaveLength(0);
    expect(second.to).toBe(MIGRATIONS.length);
  });

  it("creates every table and view of the design", () => {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const table of [
      "schema_migrations",
      "projects",
      "chains",
      "tasks",
      "runs",
      "events",
      "doubts",
      "decisions",
      "permission_audit",
      "settings",
      "v_runs_by_status",
      "v_cost_by_project_day",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("enforces foreign keys and check constraints", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      repos.chains.create({ projectId: "missing", title: "orphan" }),
    ).toThrow(/FOREIGN KEY/i);

    const projectId = seedProject();
    expect(() =>
      db
        .prepare(
          "INSERT INTO chains (id, project_id, title, status, created_at) VALUES (?,?,?,?,?)",
        )
        .run(ulid(), projectId, "bad", "nonsense", new Date().toISOString()),
    ).toThrow(/CHECK/i);
  });

  it("rejects invalid JSON in json columns", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    expect(() =>
      db
        .prepare(
          `INSERT INTO doubts (id, ref, project_id, task_id, kind, context, blocks, options, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(ulid(), "D-9", projectId, taskId, "functional", "c", "b", "not json", "now"),
    ).toThrow(/CHECK/i);
  });

  it("reports health only when the schema is present", () => {
    expect(checkDatabase(db)).toEqual({ ok: true });
    const empty = openDb({ file: ":memory:" });
    expect(checkDatabase(empty).ok).toBe(false);
  });
});

describe("projects repo", () => {
  it("creates, reads, updates and hides archived projects", () => {
    const created = repos.projects.create({
      id: slugify("Demo Project"),
      name: "Demo Project",
      path: "/workspace/projects/demo-project",
      verifyCmd: "npm test",
    });
    expect(created.id).toBe("demo-project");
    expect(created.push_policy).toBe("manual");
    expect(created.policy_pack).toBe("default");

    const updated = repos.projects.update(created.id, {
      pushPolicy: "auto",
      repoRemote: "git@example.com:demo.git",
    });
    expect(updated.push_policy).toBe("auto");
    expect(updated.repo_remote).toBe("git@example.com:demo.git");

    repos.projects.update(created.id, { archived: true });
    expect(repos.projects.list()).toHaveLength(0);
    expect(repos.projects.list({ includeArchived: true })).toHaveLength(1);
    expect(() => repos.projects.getOrThrow("nope")).toThrow(/not found/);
  });
});

describe("chains and tasks repos", () => {
  it("appends tasks in order and finds the next queued one", () => {
    const projectId = seedProject();
    const chain = repos.chains.create({ projectId, title: "three steps" });
    const tasks = repos.tasks.createMany(
      ["one", "two", "three"].map((title) => ({
        chainId: chain.id,
        projectId,
        title,
        spec: title,
        agentId: "builder",
      })),
    );
    expect(tasks.map((t) => t.position)).toEqual([1, 2, 3]);
    expect(repos.tasks.nextQueued(chain.id)?.title).toBe("one");

    repos.tasks.setStatus(tasks[0]!.id, "ok");
    expect(repos.tasks.nextQueued(chain.id)?.title).toBe("two");

    repos.chains.setStatus(chain.id, "completed");
    expect(repos.chains.activeForProject(projectId)).toBeUndefined();
    expect(repos.chains.listByProject(projectId, { status: "completed" })).toHaveLength(1);
  });

  it("refuses duplicate positions within a chain", () => {
    const projectId = seedProject();
    const chain = repos.chains.create({ projectId, title: "c" });
    const base = {
      chainId: chain.id,
      projectId,
      title: "t",
      spec: "s",
      agentId: "builder",
      position: 1,
    };
    repos.tasks.create(base);
    expect(() => repos.tasks.create(base)).toThrow(/UNIQUE/i);
  });

  it("rolls back a failed batch insert", () => {
    const projectId = seedProject();
    const chain = repos.chains.create({ projectId, title: "c" });
    expect(() =>
      repos.tasks.createMany([
        { chainId: chain.id, projectId, title: "ok", spec: "s", agentId: "a", position: 1 },
        { chainId: chain.id, projectId, title: "dup", spec: "s", agentId: "a", position: 1 },
      ]),
    ).toThrow();
    expect(repos.tasks.listByChain(chain.id)).toHaveLength(0);
  });
});

describe("runs repo", () => {
  it("numbers attempts, finishes runs and lists history", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);

    const first = repos.runs.start({ taskId, engine: "claude", model: "sonnet" });
    expect(first.attempt).toBe(1);
    expect(first.status).toBe("running");

    repos.runs.finish(first.id, {
      status: "verify_failed",
      exitReason: "tests failed",
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.03,
    });
    const second = repos.runs.start({ taskId, engine: "codex" });
    expect(second.attempt).toBe(2);
    expect(repos.runs.listByTask(taskId)).toHaveLength(2);
    expect(repos.runs.listActive().map((r) => r.id)).toEqual([second.id]);

    const history = repos.runs.history({ projectId, limit: 10 });
    expect(history).toHaveLength(2);
    expect(repos.runs.history({ projectId: "other" })).toHaveLength(0);
  });

  it("marks orphaned runs interrupted with their session, once", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude", acpSession: "sess-1" });

    const interrupted = repos.runs.markInterrupted();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.status).toBe("interrupted");
    expect(interrupted[0]!.acp_session).toBe("sess-1");
    expect(repos.runs.getOrThrow(run.id).exit_reason).toBe("container restart");
    expect(repos.runs.markInterrupted()).toHaveLength(0);
  });

  it("aggregates cost per project and day through the views", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude" });
    repos.runs.finish(run.id, { status: "ok", costUsd: 1.5, tokensIn: 10, tokensOut: 5 });

    const rows = db
      .prepare("SELECT project_id, runs, cost_usd FROM v_cost_by_project_day")
      .all() as { project_id: string; runs: number; cost_usd: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost_usd).toBeCloseTo(1.5);

    const byStatus = db
      .prepare("SELECT status, runs FROM v_runs_by_status WHERE project_id = ?")
      .all(projectId) as { status: string; runs: number }[];
    expect(byStatus).toEqual([{ status: "ok", runs: 1 }]);
  });
});

describe("events repo", () => {
  it("appends, paginates by cursor and finds the last action", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude" });

    const first = repos.events.append({
      runId: run.id,
      type: "run.state",
      payload: { status: "running" },
    });
    repos.events.append({ runId: run.id, type: "tool.call", payload: { kind: "read" } });
    const lastEdit = repos.events.append({
      runId: run.id,
      type: "file.edit",
      payload: { path: "src/a.ts", op: "write" },
    });
    repos.events.append({ type: "system.auth", payload: { engine: "codex" } });

    expect(repos.events.listByRun(run.id)).toHaveLength(3);
    expect(repos.events.listByRun(run.id, { after: first.id })).toHaveLength(2);
    expect(repos.events.listAfter(0)).toHaveLength(4);
    expect(repos.events.lastAction(run.id)?.id).toBe(lastEdit.id);
    expect(repos.events.latestId()).toBeGreaterThan(lastEdit.id - 1);
    expect(JSON.parse(lastEdit.payload)).toEqual({ path: "src/a.ts", op: "write" });
  });

  it("prunes events older than the retention window (DB-04)", () => {
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    repos.events.append({ type: "system", payload: {}, ts: old });
    repos.events.append({ type: "system", payload: {} });
    expect(repos.events.pruneOlderThan(90)).toBe(1);
    expect(repos.events.listAfter(0)).toHaveLength(1);
  });
});

describe("doubts repo", () => {
  it("numbers refs per project and resolves by id or ref", () => {
    const a = seedProject("alpha");
    const b = seedProject("beta");
    const taskA = seedTask(a).taskId;
    const taskB = seedTask(b).taskId;

    const first = repos.doubts.open({
      projectId: a,
      taskId: taskA,
      kind: "functional",
      context: "ambiguous spec",
      blocks: "task 2",
      options: [
        { id: "A", text: "do X" },
        { id: "B", text: "do Y" },
      ],
      recommendation: "A",
    });
    const second = repos.doubts.open({
      projectId: a,
      taskId: taskA,
      kind: "permission",
      context: "wants network",
      blocks: "install",
      options: [{ id: "A", text: "allow once" }],
    });
    const other = repos.doubts.open({
      projectId: b,
      taskId: taskB,
      kind: "functional",
      context: "same number, other project",
      blocks: "nothing",
      options: [{ id: "A", text: "x" }],
    });

    expect([first.ref, second.ref]).toEqual(["D-1", "D-2"]);
    expect(other.ref).toBe("D-1");
    expect(repos.doubts.resolve("D-1", a)?.id).toBe(first.id);
    expect(repos.doubts.resolve("D-1", b)?.id).toBe(other.id);
    expect(repos.doubts.resolve("D-1")).toBeUndefined(); // ambiguous without a project
    expect(repos.doubts.resolve(first.id)?.ref).toBe("D-1");
    expect(repos.doubts.options(first)).toHaveLength(2);
  });

  it("tracks the second opinion and the answer", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const doubt = repos.doubts.open({
      projectId,
      taskId,
      kind: "functional",
      context: "c",
      blocks: "b",
      options: [{ id: "A", text: "x" }],
    });

    const withOpinion = repos.doubts.setSecondOpinion(doubt.id, {
      engine: "codex",
      agrees: true,
      confidence: 0.82,
    });
    expect(repos.doubts.secondOpinion(withOpinion)?.confidence).toBeCloseTo(0.82);
    expect(repos.doubts.listOpen(projectId)).toHaveLength(1);

    const answered = repos.doubts.answer(doubt.id, "A");
    expect(answered.status).toBe("answered");
    expect(answered.answered_at).not.toBeNull();
    expect(repos.doubts.listOpen(projectId)).toHaveLength(0);
    expect(repos.doubts.close(doubt.id).status).toBe("closed");
  });
});

describe("decisions and audit repos", () => {
  it("records decisions and exposes the latest per project", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const doubt = repos.doubts.open({
      projectId,
      taskId,
      kind: "functional",
      context: "c",
      blocks: "b",
      options: [{ id: "A", text: "x" }],
    });

    repos.decisions.record({
      projectId,
      taskId,
      doubtId: doubt.id,
      kind: "provisional",
      question: "sync strategy?",
      choice: "incremental",
      checkpointTag: "lo/checkpoint-1",
    });
    const latest = repos.decisions.record({
      projectId,
      kind: "human",
      question: "push?",
      choice: "manual",
    });

    expect(repos.decisions.latest(projectId)?.id).toBe(latest.id);
    expect(repos.decisions.listByProject(projectId)).toHaveLength(2);
    expect(repos.decisions.listByDoubt(doubt.id)).toHaveLength(1);
  });

  it("audits permission verdicts per run", () => {
    const projectId = seedProject();
    const { taskId } = seedTask(projectId);
    const run = repos.runs.start({ taskId, engine: "claude" });

    repos.audit.record({
      runId: run.id,
      actionClass: "fs.write",
      detail: { path: "src/a.ts" },
      ruleSource: "project",
      verdict: "allow",
      latencyMs: 3.7,
    });
    repos.audit.record({
      runId: run.id,
      actionClass: "net.fetch",
      detail: { url: "https://example.com" },
      ruleSource: "default",
      verdict: "require_human",
      latencyMs: 12,
    });

    const rows = repos.audit.listByRun(run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.latency_ms).toBe(4);
    expect(repos.audit.countByVerdict(run.id)).toEqual({
      allow: 1,
      deny: 0,
      require_human: 1,
      provisional: 0,
    });
  });
});

describe("settings repo and transactions", () => {
  it("upserts values and round-trips JSON", () => {
    repos.settings.set("panel.theme", "dark");
    repos.settings.set("panel.theme", "darker");
    expect(repos.settings.get("panel.theme")).toBe("darker");
    expect(repos.settings.get("missing")).toBeUndefined();

    repos.settings.setJson("engines.lastAuth", { claude: true });
    expect(repos.settings.getJson<{ claude: boolean }>("engines.lastAuth")).toEqual({
      claude: true,
    });
    expect(Object.keys(repos.settings.all())).toContain("panel.theme");
  });

  it("rolls back an immediate transaction on throw", () => {
    expect(() =>
      transaction(db, () => {
        repos.projects.create({ id: "temp", name: "temp", path: "/tmp/temp" });
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(repos.projects.get("temp")).toBeUndefined();
  });
});

describe("ids", () => {
  it("produces sortable 26-char ulids and safe slugs", () => {
    const early = ulid(1000);
    const late = ulid(2000);
    expect(early).toHaveLength(26);
    expect(early < late).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => ulid())).size).toBe(500);

    expect(slugify("Proyecto Ñandú 2024!")).toBe("proyecto-nandu-2024");
    expect(() => slugify("¡!")).toThrow(/empty slug/);
  });
});
