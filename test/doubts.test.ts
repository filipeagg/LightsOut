/** Phase 5 gate: advisor parsing, the auto-continue rule, answering and the permission gate. */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { loadConfig } from "../src/config.js";
import { createBus } from "../src/bus.js";
import { DoubtService, isReversible } from "../src/orchestrator/doubts.js";
import { otherEngine, parseAdvisorAnswer } from "../src/acp/advisor.js";
import type { AdvisorResult } from "../src/acp/advisor.js";

let db: Db;
let repos: Repos;
let dir: string;

const OPTIONS = [
  { id: "A", text: "incremental by timestamp" },
  { id: "B", text: "full dump" },
];

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  dir = await mkdtemp(path.join(tmpdir(), "lo-doubt-"));
  await mkdir(path.join(dir, "doc"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seed() {
  const project = repos.projects.create({ id: "demo", name: "Demo", path: dir });
  const chain = repos.chains.create({ projectId: project.id, title: "sync" });
  const task = repos.tasks.create({
    chainId: chain.id,
    projectId: project.id,
    title: "Sync engine",
    spec: "build it",
    agentId: "builder",
  });
  const run = repos.runs.start({ taskId: task.id, engine: "claude" });
  return { project, chain, task, run };
}

/** DoubtService with the advisor call replaced by a fixed answer. */
function service(advisor: AdvisorResult | undefined, overrides: Record<string, string> = {}) {
  const config = loadConfig({ LO_WORKSPACE: dir, LO_DB: ":memory:", ...overrides });
  const agents = { pack: () => undefined, profileOrThrow: () => undefined } as never;
  const svc = new DoubtService(config, repos, createBus(), agents);
  // The advisor is a network/process call; the rule around it is what these tests check.
  vi.spyOn(
    svc as unknown as { secondOpinion: () => Promise<AdvisorResult | undefined> },
    "secondOpinion",
  ).mockResolvedValue(advisor);
  return svc;
}

const agreeing = (confidence: number, choice = "A"): AdvisorResult => ({
  ok: true,
  engine: "codex",
  durationMs: 10,
  answer: { choice, confidence, rationale: "same reading of the repo" },
});

describe("advisor helpers", () => {
  it("always asks the other engine", () => {
    expect(otherEngine("claude")).toBe("codex");
    expect(otherEngine("codex")).toBe("claude");
  });

  it("extracts the JSON answer from a reply with prose or a fence", () => {
    expect(parseAdvisorAnswer('{"choice":"A","confidence":0.9,"rationale":"x"}')).toMatchObject({
      choice: "A",
      confidence: 0.9,
    });
    expect(
      parseAdvisorAnswer('Sure.\n```json\n{"choice":"B","confidence":0.4,"rationale":"y"}\n```'),
    ).toMatchObject({ choice: "B" });
    expect(
      parseAdvisorAnswer('I think {"choice":"A","confidence":"0.75","rationale":"z"} is right'),
    ).toMatchObject({ confidence: 0.75 });
    expect(parseAdvisorAnswer("no json at all")).toBeUndefined();
    expect(parseAdvisorAnswer('{"choice":"A"}')).toBeUndefined(); // confidence required
  });

  it("knows which action classes may never auto-continue", () => {
    expect(isReversible(undefined)).toBe(true);
    expect(isReversible("project_write")).toBe(true);
    expect(isReversible("deps_install")).toBe(true);
    for (const cls of ["delete", "git_push", "credentials", "publish_external", "outside_workspace"]) {
      expect(isReversible(cls)).toBe(false);
    }
  });
});

describe("raising a doubt", () => {
  it("auto-continues when the advisor agrees confidently (DO-02)", async () => {
    const { project, task, run } = seed();
    const svc = service(agreeing(0.86));

    const result = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "Incremental or full sync on reconnect?",
      blocks: "task 3",
      options: OPTIONS,
      recommendation: "A",
    });

    expect(result.outcome).toBe("auto_continue");
    expect(repos.doubts.listOpen(project.id)).toHaveLength(0);

    const decision = repos.decisions.latest(project.id);
    expect(decision).toMatchObject({ kind: "provisional" });
    expect(decision?.choice).toContain("incremental");
    expect(decision?.rationale).toContain("0.86");

    const decisions = await readFile(path.join(dir, "doc", "DECISIONS.md"), "utf8");
    expect(decisions).toContain("incremental");
  });

  it("opens the doubt when the advisor disagrees (DO-03)", async () => {
    const { project, task, run } = seed();
    const svc = service(agreeing(0.95, "B"));

    const result = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "Incremental or full sync on reconnect?",
      blocks: "task 3",
      options: OPTIONS,
      recommendation: "A",
    });

    expect(result.outcome).toBe("opened");
    if (result.outcome !== "opened") return;
    expect(result.doubt.ref).toBe("D-1");
    const opinion = repos.doubts.secondOpinion(result.doubt);
    expect(opinion).toMatchObject({ engine: "codex", agrees: false, confidence: 0.95 });

    const questions = await readFile(path.join(dir, "doc", "QUESTIONS.md"), "utf8");
    expect(questions).toContain("@DOUBT-OPEN D-1");
    expect(questions).toContain("- Option A: incremental by timestamp");
    expect(questions).toContain("- Answer: (pending)");
  });

  it("opens the doubt when the advisor agrees but is not confident enough", async () => {
    const { project, task, run } = seed();
    const svc = service(agreeing(0.5)); // threshold defaults to 0.7

    const result = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "c",
      blocks: "b",
      options: OPTIONS,
      recommendation: "A",
    });
    expect(result.outcome).toBe("opened");
  });

  it("opens the doubt when the advisor failed, never continuing on silence", async () => {
    const { project, task, run } = seed();
    const svc = service({ ok: false, engine: "codex", error: "timeout", durationMs: 60_000 });

    const result = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "c",
      blocks: "b",
      options: OPTIONS,
      recommendation: "A",
    });
    expect(result.outcome).toBe("opened");
    if (result.outcome !== "opened") return;
    expect(repos.doubts.secondOpinion(result.doubt)?.reasoning).toContain("timeout");
  });

  it("opens the doubt when there is no recommendation to agree with", async () => {
    const { project, task, run } = seed();
    const svc = service(agreeing(0.99));
    const result = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "c",
      blocks: "b",
      options: OPTIONS,
      recommendation: null,
    });
    expect(result.outcome).toBe("opened");
  });

  it("stops auto-continuing after the budget for one task is spent", async () => {
    const { project, task, run } = seed();
    const svc = service(agreeing(0.9));
    const raise = () =>
      svc.raise({
        project,
        task,
        runId: run.id,
        kind: "functional",
        engine: "claude",
        context: "c",
        blocks: "b",
        options: OPTIONS,
        recommendation: "A",
      });

    for (let i = 0; i < DoubtService.MAX_AUTO_CONTINUE; i++) {
      expect((await raise()).outcome).toBe("auto_continue");
    }
    expect((await raise()).outcome).toBe("opened");
  });
});

describe("answering a doubt", () => {
  it("records a human decision, mirrors it and closes the mirror block (DO-04)", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);
    const opened = await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "Incremental or full?",
      blocks: "task 3",
      options: OPTIONS,
      recommendation: "A",
    });
    expect(opened.outcome).toBe("opened");

    const result = await svc.answer({
      doubtId: "D-1",
      projectId: project.id,
      choice: "B",
      note: "the source cannot be trusted for timestamps",
    });

    expect(result.doubt.status).toBe("answered");
    expect(result.doubt.answer).toContain("full dump");
    expect(result.doubt.answer).toContain("timestamps");

    const decision = repos.decisions.latest(project.id);
    expect(decision).toMatchObject({ kind: "human" });
    expect(decision?.doubt_id).toBe(result.doubt.id);

    const questions = await readFile(path.join(dir, "doc", "QUESTIONS.md"), "utf8");
    expect(questions).toContain("@DOUBT-CLOSED D-1");
    expect(questions).not.toContain("@DOUBT-OPEN D-1");
    expect(questions).toContain("full dump");
    // The mirror is regenerated, not duplicated.
    expect(questions.match(/### D-1/g)).toHaveLength(1);

    const decisions = await readFile(path.join(dir, "doc", "DECISIONS.md"), "utf8");
    expect(decisions).toContain("D-1 —");
  });

  it("refuses to answer twice and reports an unknown ref", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);
    await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "c",
      blocks: "b",
      options: OPTIONS,
      recommendation: "A",
    });
    await svc.answer({ doubtId: "D-1", projectId: project.id, choice: "A" });

    await expect(
      svc.answer({ doubtId: "D-1", projectId: project.id, choice: "B" }),
    ).rejects.toThrow(/already answered/);
    await expect(svc.answer({ doubtId: "D-99", projectId: project.id, choice: "A" })).rejects.toThrow(
      /not found/,
    );
  });

  it("builds the decision context that a re-run receives", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);
    await svc.raise({
      project,
      task,
      runId: run.id,
      kind: "functional",
      engine: "claude",
      context: "Incremental or full?",
      blocks: "b",
      options: OPTIONS,
      recommendation: "A",
    });
    expect(svc.decisionContext(task.id)).toBe("");

    await svc.answer({ doubtId: "D-1", projectId: project.id, choice: "A" });
    const context = svc.decisionContext(task.id);
    expect(context).toContain("Decisions already taken");
    expect(context).toContain("incremental by timestamp");
    expect(context).toContain("Do not reopen");
  });
});

describe("permission gate", () => {
  const options = [
    { optionId: "allow-1", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject-1", name: "Reject", kind: "reject_once" as const },
  ];

  it("holds the ACP response until a human answers, then allows (DESIGN §6.5)", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);

    const gate = svc.gatePermission({
      project,
      task,
      runId: run.id,
      engine: "claude",
      actionClass: "deps_install",
      title: "npm install left-pad",
      reason: "dependencies change the build",
      options,
    });

    // The doubt must exist while the gate waits.
    await vi.waitFor(() => expect(repos.doubts.listOpen(project.id)).toHaveLength(1));
    const doubt = repos.doubts.listOpen(project.id)[0]!;
    expect(doubt.kind).toBe("permission");

    await svc.answer({ doubtId: doubt.id, choice: "A" });
    await expect(gate).resolves.toEqual({ optionId: "allow-1" });
  });

  it("can be released by another process through the database", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);

    const gate = svc.gatePermission({
      project,
      task,
      runId: run.id,
      engine: "claude",
      actionClass: "deps_install",
      title: "npm install x",
      reason: "r",
      options,
      pollMs: 50,
    });
    await vi.waitFor(() => expect(repos.doubts.listOpen(project.id)).toHaveLength(1));
    const doubt = repos.doubts.listOpen(project.id)[0]!;

    // Simulate a different process answering: write straight to the database, no resolver.
    repos.doubts.answer(doubt.id, "A: Allow — approved elsewhere");
    await expect(gate).resolves.toEqual({ optionId: "allow-1" });
  });

  it("rejects with an explanation when the human refuses", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);

    const gate = svc.gatePermission({
      project,
      task,
      runId: run.id,
      engine: "claude",
      actionClass: "network",
      title: "curl https://example.com",
      reason: "outbound access is allowlisted",
      options,
    });
    await vi.waitFor(() => expect(repos.doubts.listOpen(project.id)).toHaveLength(1));
    const doubt = repos.doubts.listOpen(project.id)[0]!;

    await svc.answer({ doubtId: doubt.id, choice: "B", note: "not needed" });
    const result = await gate;
    expect(result).toMatchObject({ reject: true });
    if ("reject" in result) expect(result.explanation).toContain("refused");
  });

  it("gives up after the slow clock and leaves the doubt open (§8.4)", async () => {
    const { project, task, run } = seed();
    const svc = service(undefined);

    const result = await svc.gatePermission({
      project,
      task,
      runId: run.id,
      engine: "claude",
      actionClass: "deps_install",
      title: "npm install x",
      reason: "r",
      options,
      waitMs: 300, // stand-in for the 24 h slow clock
      pollMs: 50,
    });
    expect(result).toMatchObject({ reject: true });
    if ("reject" in result) expect(result.explanation).toContain("No human answered");
    expect(repos.doubts.listOpen(project.id)).toHaveLength(1); // still open
    const types = repos.events.listByRun(run.id).map((e) => e.type);
    expect(types).toContain("system");
  });
});
