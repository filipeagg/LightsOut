/**
 * OR-06 / OR-09: stopping work that is already running. The registry of live sessions is what
 * makes this possible, so these tests drive it directly with a session that records the abort
 * instead of spawning a real adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { LiveRuns } from "../src/acp/live.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { Actions } from "../src/control/actions.js";
import { loadConfig } from "../src/config.js";
import { createBus } from "../src/bus.js";

let db: Db;
let repos: Repos;
let dir: string;

beforeEach(async () => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
  dir = await mkdtemp(path.join(tmpdir(), "lo-stop-"));
  await mkdir(path.join(dir, "doc"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * An orchestrator whose runner never returns on its own: the task stays in flight until the
 * session is aborted, which is exactly the situation a stop has to deal with.
 */
async function held() {
  const config = loadConfig({ LO_WORKSPACE: dir, LO_DB: ":memory:" });
  const live = new LiveRuns();
  const aborted: string[] = [];
  let releaseRun: (() => void) | undefined;

  const runner = {
    live,
    run: async (input: { project: { id: string }; task: { id: string; chain_id: string } }) => {
      const run = repos.runs.start({ taskId: input.task.id, engine: "claude" });
      repos.tasks.setStatus(input.task.id, "running");
      live.register({
        runId: run.id,
        taskId: input.task.id,
        projectId: input.project.id,
        chainId: input.task.chain_id,
        acpSession: () => "acp-1",
        startedAt: Date.now(),
        abort: async () => {
          aborted.push(run.id);
          releaseRun?.();
        },
      });
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      live.unregister(run.id);
      repos.runs.finish(run.id, { status: "aborted", exitReason: "cancelled" });
      repos.tasks.setStatus(input.task.id, "aborted");
      return {
        runId: run.id,
        outcome: {
          status: "aborted" as const,
          summary: "",
          exitReason: "cancelled",
          sentinelMissing: true,
        },
      };
    },
  };

  const project = repos.projects.create({ id: "stoppy", name: "Stoppy", path: dir });
  const agents = { profileOrThrow: () => undefined, profile: () => ({ enabled: true }) } as never;
  const orch = new Orchestrator(config, repos, createBus(), agents, runner as never);
  const actions = new Actions({ config, repos, agents, orchestrator: orch });
  return { project, orch, actions, live, aborted };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("stop the run that is running (OR-06, OR-09)", () => {
  it("reaches the live session, aborts it and pauses the chain", async () => {
    const { project, orch, actions, live, aborted } = await held();
    const launch = orch.launchChain({
      projectId: project.id,
      title: "long",
      tasks: [
        { title: "one", spec: "s", agentId: "builder" },
        { title: "two", spec: "s", agentId: "builder" },
      ],
    });
    await settle();
    const handle = live.forProject(project.id)[0];
    expect(handle).toBeDefined();

    const result = await actions.stopRun("panel", { runId: handle!.runId });

    expect(result.stopped).toBe(true);
    expect(aborted).toEqual([handle!.runId]);
    expect(result.chainPaused).toBe(true);
    await orch.idle();
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("paused");
    // The queue is untouched by a stop: that is what abort is for.
    expect(repos.tasks.getOrThrow(launch.taskIds[1]!).status).toBe("queued");
    expect(live.size).toBe(0);
  });

  it("finds the run of a project without being told the run id", async () => {
    const { project, orch, actions, live } = await held();
    orch.launchChain({
      projectId: project.id,
      title: "long",
      tasks: [{ title: "one", spec: "s", agentId: "builder" }],
    });
    await settle();
    const runId = live.forProject(project.id)[0]!.runId;

    const result = await actions.stopRun("mcp", { projectId: project.id });

    expect(result.runId).toBe(runId);
    expect(result.stopped).toBe(true);
    await orch.idle();
  });

  it("says nothing was running instead of pretending, and corrects a stale row", async () => {
    const { project, orch } = await held();
    const chain = repos.chains.create({ projectId: project.id, title: "ghost" });
    const task = repos.tasks.createMany([
      { chainId: chain.id, projectId: project.id, title: "t", spec: "s", agentId: "builder" },
    ])[0]!;
    const run = repos.runs.start({ taskId: task.id, engine: "claude" });
    repos.tasks.setStatus(task.id, "running");

    const result = await orch.stopRun(run.id, "stopped by panel");

    expect(result.stopped).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(repos.runs.getOrThrow(run.id).status).toBe("interrupted");
    expect(repos.tasks.getOrThrow(task.id).status).toBe("interrupted");
  });

  it("pauses nothing when the run had already finished on its own", async () => {
    // Found on the live system: a stop that arrives a second after the agent finished must not
    // leave a chain that was completing looking paused.
    const { project, actions } = await held();
    const chain = repos.chains.create({ projectId: project.id, title: "already done" });
    const task = repos.tasks.createMany([
      { chainId: chain.id, projectId: project.id, title: "t", spec: "s", agentId: "builder" },
    ])[0]!;
    const run = repos.runs.start({ taskId: task.id, engine: "claude" });
    repos.runs.finish(run.id, { status: "ok", summary: "done" });
    repos.tasks.setStatus(task.id, "ok");

    const result = await actions.stopRun("panel", { runId: run.id });

    expect(result.stopped).toBe(false);
    expect(result.reconciled).toBe(false);
    expect(result.chainPaused).toBe(false);
    expect(repos.chains.getOrThrow(chain.id).status).toBe("active");
  });

  it("aborting a chain stops the running agent and drops the queue (OR-06)", async () => {
    const { project, orch, actions, live, aborted } = await held();
    const launch = orch.launchChain({
      projectId: project.id,
      title: "doomed",
      tasks: [
        { title: "one", spec: "s", agentId: "builder" },
        { title: "two", spec: "s", agentId: "builder" },
      ],
    });
    await settle();
    const runId = live.forProject(project.id)[0]!.runId;

    const result = await actions.abortRun("panel", { chainId: launch.chainId });

    expect(result.stopped).toEqual([runId]);
    expect(aborted).toEqual([runId]);
    expect(result.aborted).toEqual([launch.taskIds[1]]);
    await orch.idle();
    // The aborted task's outcome lands after the decision and must not turn this into "paused".
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("aborted");
  });

  it("letCurrentFinish keeps the old behaviour, on purpose and only when asked", async () => {
    const { project, orch, actions, live, aborted } = await held();
    const launch = orch.launchChain({
      projectId: project.id,
      title: "drain",
      tasks: [
        { title: "one", spec: "s", agentId: "builder" },
        { title: "two", spec: "s", agentId: "builder" },
      ],
    });
    await settle();
    const handle = live.forProject(project.id)[0]!;

    const result = await actions.abortRun("panel", {
      chainId: launch.chainId,
      letCurrentFinish: true,
    });

    expect(result.stopped).toEqual([]);
    expect(aborted).toEqual([]);
    expect(live.get(handle.runId)).toBeDefined();

    // Clean up: release the held run so the temp directory can go.
    await handle.abort();
    await orch.idle();
  });
});

describe("permission gates held by a stopped run", () => {
  it("are closed with a reason instead of waiting for an answer nobody will give", async () => {
    const { project, orch } = await held();
    const chain = repos.chains.create({ projectId: project.id, title: "gated" });
    const task = repos.tasks.createMany([
      { chainId: chain.id, projectId: project.id, title: "t", spec: "s", agentId: "builder" },
    ])[0]!;
    const run = repos.runs.start({ taskId: task.id, engine: "claude" });
    const doubt = repos.doubts.open({
      projectId: project.id,
      taskId: task.id,
      runId: run.id,
      kind: "permission",
      context: "wants to run something",
      blocks: "the task",
      options: [
        { id: "A", text: "allow" },
        { id: "B", text: "refuse" },
      ],
    });

    await orch.stopRun(run.id, "stopped by panel");

    const after = repos.doubts.getOrThrow(doubt.id);
    expect(after.status).toBe("closed");
    expect(after.answer).toContain("cancelled");
    expect(repos.doubts.listOpen(project.id)).toHaveLength(0);
  });
});

