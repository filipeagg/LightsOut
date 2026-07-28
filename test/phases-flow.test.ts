/**
 * Phase 9: the phase layer end to end against a deterministic runner (TP-05..08, §16.2).
 * The ACP layer is faked; what is under test is materialisation, the deliverable check, the
 * gate and what happens after it is answered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createBus } from "../src/bus.js";
import { loadConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { GATE_CONTINUE, GATE_STOP, PhaseService, globToRegExp } from "../src/orchestrator/phases.js";
import { projectTemplateSchema } from "../src/templates/schema.js";

let db: Db;
let repos: Repos;
let workspace: string;

/**
 * A runner that finishes every task ok, optionally writing the file the phase promised. What
 * it writes is how the deliverable check is exercised without a real agent.
 */
function fakeRunner(options: { writeDeliverables: boolean; fail?: boolean }) {
  return {
    async run(input: { project: { path: string }; task: { id: string; spec: string } }) {
      const run = repos.runs.start({ taskId: input.task.id, engine: "claude" });
      // The spec reads "Deliverable: doc/PROMPT.md. The phase is not…": take the path, not
      // the sentence's full stop.
      const match = /Deliverable: (\S+?)\.(?:\s|$)/.exec(input.task.spec);
      if (options.writeDeliverables && match) {
        const file = path.join(input.project.path, match[1]!);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "produced", "utf8");
      }
      const status = options.fail ? ("error" as const) : ("ok" as const);
      repos.runs.finish(run.id, { status });
      repos.tasks.setStatus(input.task.id, status);
      return {
        runId: run.id,
        outcome: { status, summary: "", exitReason: "finished", sentinelMissing: false },
      };
    },
  };
}

const TEMPLATE = projectTemplateSchema.parse({
  id: "twostep",
  name: "Two step",
  phases: [
    {
      id: "shape",
      title: "Shape it",
      agent: "planner",
      gate: "human",
      deliverable: "doc/PROMPT.md",
      instructions: "shape the request",
    },
    {
      id: "build",
      title: "Build it",
      agent: "builder",
      repeatable: true,
      instructions: "build it",
    },
  ],
});

async function harness(runnerOptions: { writeDeliverables: boolean; fail?: boolean }) {
  const config = loadConfig({ LO_WORKSPACE: workspace, LO_DB: ":memory:" });
  const agents = {
    profile: (id: string) => ({ id, enabled: true }),
    profileOrThrow: (id: string) => ({ id, enabled: true }),
  } as never;
  const bus = createBus();
  const orch = new Orchestrator(
    config,
    repos,
    bus,
    agents,
    fakeRunner(runnerOptions) as never,
  );
  const phases = new PhaseService(config, repos, bus, agents, orch);
  orch.setPhaseHooks({
    onTaskClosed: (taskId) => phases.onTaskClosed(taskId),
    onGateAnswered: (doubt, choice) => phases.onGateAnswered(doubt, choice),
  });

  // The project row and its directory directly: git is not installed in the test image, and
  // what is under test here is the phase layer, not the scaffolding of phase 4.
  const projectPath = path.join(workspace, "projects", "phased");
  await mkdir(path.join(projectPath, "doc"), { recursive: true });
  const project = repos.projects.create({
    id: "phased",
    name: "Phased",
    path: projectPath,
    templateId: TEMPLATE.id,
  });
  repos.chains.create({ projectId: project.id, title: project.name });
  phases.materialise(project.id, TEMPLATE);
  return { config, orch, phases, project };
}

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  workspace = await mkdtemp(path.join(tmpdir(), "lo-flow-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/**
 * KB-05c (§17.1c): `workspace:` is the system's own notation, and it reached the agent verbatim in
 * the spec — a string nobody had taught it, in a prompt whose every other path was relative. It
 * wrote the relative version, which landed inside the project.
 */
describe("the deliverable as the agent has to type it (KB-05c)", () => {
  it("expands a workspace: deliverable into the absolute path", async () => {
    const { phases, project, config } = await harness({ writeDeliverables: false });
    const phase = repos.phases.list(project.id)[0]!;
    const spec = phases.buildSpec(
      { ...phase, deliverable: "workspace:knowledge/mercado/index.md" },
      "the request",
      "what comes back",
    );
    expect(spec).toContain(path.join(config.workspace, "knowledge/mercado/index.md"));
    expect(spec).not.toContain("workspace:knowledge");
  });

  it("leaves a project-relative deliverable exactly as written", async () => {
    const { phases, project } = await harness({ writeDeliverables: false });
    const phase = repos.phases.list(project.id)[0]!;
    const spec = phases.buildSpec(phase, "the request", "what comes back");
    expect(spec).toContain("Deliverable: doc/PROMPT.md");
  });
});

/**
 * TP-07, §16.2: a plan of repeatable phases is a cycle, and a cycle has to be able to come round
 * again. The failure: a nightly digest is `gather` → `curate`, both repeatable; after one pass both
 * were `done`, so a trigger on `gather` re-ran the first step and nothing followed it.
 */
describe("relaunching a repeatable phase restarts the repeatable tail", () => {
  const CYCLE = projectTemplateSchema.parse({
    id: "cycle",
    name: "Cycle",
    phases: [
      { id: "gather", title: "Gather", agent: "builder", repeatable: true, instructions: "gather" },
      { id: "curate", title: "Curate", agent: "builder", repeatable: true, instructions: "curate" },
      { id: "audit", title: "Audit", agent: "builder", instructions: "audit" },
    ],
  });

  it("puts the later repeatable phases back to pending, and leaves the rest alone", async () => {
    const { phases, project } = await harness({ writeDeliverables: true });
    // A second project so the two-phase template of the outer harness is not in the way.
    const path2 = path.join(workspace, "projects", "cycled");
    await mkdir(path2, { recursive: true });
    const cycled = repos.projects.create({ id: "cycled", name: "Cycled", path: path2 });
    repos.chains.create({ projectId: cycled.id, title: cycled.name });
    phases.materialise(cycled.id, CYCLE);

    // One full pass: everything ends up done.
    for (const row of repos.phases.list(cycled.id)) repos.phases.setStatus(row.id, "done");

    await phases.launchPhase("mcp", cycled.id, "gather", {
      request: "tonight's items",
      expects: "the raw list",
    });

    const after = new Map(repos.phases.list(cycled.id).map((p) => [p.phase_id, p.status]));
    expect(after.get("gather")).toBe("running");
    // The repeatable phase after it is ready to run again…
    expect(after.get("curate")).toBe("pending");
    // …and the one that is not repeatable is not part of the cycle and is not touched.
    expect(after.get("audit")).toBe("done");
    // The project of the outer harness is untouched: the reset is scoped to one project.
    expect(repos.phases.list(project.id).some((p) => p.status === "pending")).toBe(true);
  });

  it("does not reset anything when the relaunched phase is not repeatable", async () => {
    const { phases, project } = await harness({ writeDeliverables: true });
    for (const row of repos.phases.list(project.id)) repos.phases.setStatus(row.id, "done");
    // `shape` is not repeatable, so relaunching it is refused outright (TP-07) — nothing resets.
    await expect(
      phases.launchPhase("mcp", project.id, "shape", { request: "again", expects: "again" }),
    ).rejects.toThrow(/not repeatable/);
    expect(repos.phases.list(project.id).every((p) => p.status === "done")).toBe(true);
  });
});

describe("phase flow", () => {
  it("materialises a template into ordered phases (TP-05)", async () => {
    const { phases, project } = await harness({ writeDeliverables: true });
    const rows = phases.list(project.id);
    expect(rows.map((p) => p.phase_id)).toEqual(["shape", "build"]);
    expect(rows[0]?.gate).toBe("human");
    expect(rows[0]?.instructions).toBe("shape the request");
    expect(rows.every((p) => p.status === "pending")).toBe(true);
    // The project's chain exists from the start, so every phase task has somewhere to go.
    expect(repos.chains.listByProject(project.id).length).toBeGreaterThan(0);
  });

  it("holds a human gate instead of starting the next phase (TP-01)", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: true });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();

    const [shape, build] = phases.list(project.id);
    expect(shape?.status).toBe("done");
    expect(build?.status).toBe("pending");

    const open = repos.doubts.listOpen(project.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("gate");
    expect(JSON.parse(open[0]!.options).map((o: { id: string }) => o.id)).toEqual([
      GATE_CONTINUE,
      GATE_STOP,
    ]);
    // A gate is a person's job: no second opinion is bought for it (§16.2).
    expect(open[0]?.second_opinion).toBeNull();
  });

  it("continues to the next phase when the gate is answered (§16.2)", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: true });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();

    const doubt = repos.doubts.listOpen(project.id)[0]!;
    const answer = await orch.answerDoubt({ doubtId: doubt.id, choice: GATE_CONTINUE });
    expect(answer.resumed).toBe(true);
    await orch.idle();

    const rows = phases.list(project.id);
    expect(rows.map((p) => p.status)).toEqual(["done", "done"]);
    // The gate's own task is not run again: one task per phase attempt.
    expect(repos.tasks.listByChain(repos.chains.listByProject(project.id)[0]!.id)).toHaveLength(2);
  });

  it("stops where it is when the gate says stop", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: true });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();

    const doubt = repos.doubts.listOpen(project.id)[0]!;
    const answer = await orch.answerDoubt({ doubtId: doubt.id, choice: GATE_STOP });
    expect(answer.resumed).toBe(false);
    await orch.idle();
    expect(phases.list(project.id)[1]?.status).toBe("pending");
  });

  it("fails the phase when the deliverable is not on disk (BA-04)", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: false });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();

    expect(phases.list(project.id)[0]?.status).toBe("failed");
    expect(repos.doubts.listOpen(project.id)).toHaveLength(0);
    const reasons = repos.events
      .listAfter(0, 200)
      .map((e) => e.payload)
      .join(" ");
    expect(reasons).toContain("deliverable missing");
  });

  it("fails the phase when its task fails", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: true, fail: true });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();
    expect(phases.list(project.id)[0]?.status).toBe("failed");
  });

  it("refuses to relaunch a phase that is not repeatable (TP-07)", async () => {
    const { orch, phases, project } = await harness({ writeDeliverables: true });
    await phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" });
    await orch.idle();
    await expect(phases.launchPhase("mcp", project.id, "shape", { request: "this run", expects: "the deliverable" })).rejects.toThrow(
      /not repeatable/,
    );
    // The repeatable one may run again and keeps its position.
    await phases.launchPhase("mcp", project.id, "build", { request: "this run", expects: "the deliverable" });
    await orch.idle();
    await phases.launchPhase("mcp", project.id, "build", { request: "this run", expects: "the deliverable" });
    await orch.idle();
    expect(phases.list(project.id)[1]?.position).toBe(1);
  });

  it("inserts an ad-hoc phase without colliding with template ids (TP-08)", async () => {
    const { phases, project } = await harness({ writeDeliverables: true });
    const added = phases.addAdhoc("mcp", project.id, {
      title: "Extra",
      agentId: "builder",
      instructions: "squeeze in",
      position: 1,
    });
    expect(added.phase_id).toBe("adhoc-1");
    expect(phases.list(project.id).map((p) => p.phase_id)).toEqual([
      "shape",
      "adhoc-1",
      "build",
    ]);
  });
});

describe("deliverable globs", () => {
  it("matches within and across segments", () => {
    expect(globToRegExp("knowledge/*/index.md").test("knowledge/erp/index.md")).toBe(true);
    expect(globToRegExp("knowledge/*/index.md").test("knowledge/a/b/index.md")).toBe(false);
    expect(globToRegExp("doc/*.md").test("doc/PROMPT.md")).toBe(true);
    expect(globToRegExp("doc/*.md").test("doc/sub/PROMPT.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
  });
});
