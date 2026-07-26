/** Phase 4 gate: locks, recovery, managed docs, verify gate and project config. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { RunLocks } from "../src/orchestrator/locks.js";
import { recoverInterrupted } from "../src/orchestrator/recovery.js";
import { runVerify } from "../src/orchestrator/verify.js";
import {
  ProjectDocs,
  flipPlanCheckbox,
  planLine,
  replaceManagedBlock,
} from "../src/projects/docs.js";
import { readProjectConfig } from "../src/projects/config.js";

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

function seedChain(projectPath = "/workspace/projects/demo") {
  const project = repos.projects.create({ id: "demo", name: "Demo", path: projectPath });
  const chain = repos.chains.create({ projectId: project.id, title: "Offline sync" });
  const tasks = repos.tasks.createMany(
    ["one", "two", "three"].map((title) => ({
      chainId: chain.id,
      projectId: project.id,
      title,
      spec: title,
      agentId: "builder",
    })),
  );
  return { project, chain, tasks };
}

describe("run locks", () => {
  it("allows one run per project and caps the total", () => {
    const locks = new RunLocks(2);
    expect(locks.tryAcquire("a", "run-a")).toBe(true);
    expect(locks.tryAcquire("a", "run-a2")).toBe(false); // project busy
    expect(locks.tryAcquire("b", "run-b")).toBe(true);
    expect(locks.atCapacity).toBe(true);
    expect(locks.tryAcquire("c", "run-c")).toBe(false); // global cap
    expect(locks.runIdFor("b")).toBe("run-b");

    locks.release("a");
    expect(locks.tryAcquire("c", "run-c")).toBe(true);
    expect(locks.snapshot()).toHaveLength(2);
  });
});

describe("recovery", () => {
  it("puts a phase left running back to pending, so the panel stops claiming it is working", () => {
    const { project, tasks } = seedChain();
    const task = tasks[0]!;
    repos.runs.start({ taskId: task.id, engine: "claude" });
    const phase = repos.phases.create({
      projectId: project.id,
      position: 1,
      phaseId: "analyse",
      title: "Read the system until you understand it",
      agentId: "codebase-analyst",
      instructions: "read",
    });
    repos.phases.markRunning(phase.id, task.id);
    expect(repos.phases.getOrThrow(phase.id).status).toBe("running");

    const report = recoverInterrupted(repos);

    // This is what the user saw: a phase row reading "running" with no run in flight.
    expect(repos.phases.getOrThrow(phase.id).status).toBe("pending");
    expect(repos.tasks.getOrThrow(task.id).status).toBe("interrupted");
    expect(report.phasesReconciled).toEqual([phase.id]);
  });

  it("also fixes a phase an earlier restart left running, with no run to interrupt", () => {
    // The leftover case, found on the live system: the run had been marked interrupted by a
    // previous boot, so a pass that only looks at what it interrupts itself sees nothing to do
    // and the panel goes on claiming the phase is working.
    const { project, tasks } = seedChain();
    const task = tasks[0]!;
    const run = repos.runs.start({ taskId: task.id, engine: "claude" });
    repos.runs.finish(run.id, { status: "interrupted", exitReason: "container restart" });
    repos.tasks.setStatus(task.id, "interrupted");
    const phase = repos.phases.create({
      projectId: project.id,
      position: 1,
      phaseId: "analyse",
      title: "Read the system",
      agentId: "codebase-analyst",
      instructions: "read",
    });
    repos.phases.markRunning(phase.id, task.id);

    const report = recoverInterrupted(repos);

    expect(report.runs).toBe(0); // nothing to interrupt this time
    expect(report.phasesReconciled).toEqual([phase.id]);
    expect(repos.phases.getOrThrow(phase.id).status).toBe("pending");
  });

  it("leaves a phase alone while its task is really working", () => {
    const { project, tasks } = seedChain();
    const task = tasks[0]!;
    repos.tasks.setStatus(task.id, "queued");
    const phase = repos.phases.create({
      projectId: project.id,
      position: 1,
      phaseId: "analyse",
      title: "Read the system",
      agentId: "codebase-analyst",
      instructions: "read",
    });
    repos.phases.markRunning(phase.id, task.id);

    const report = recoverInterrupted(repos);
    expect(report.phasesReconciled).toEqual([]);
    expect(repos.phases.getOrThrow(phase.id).status).toBe("running");
  });

  it("marks orphaned runs interrupted and pauses their chains (RT-07)", () => {
    const { chain, tasks } = seedChain();
    const run = repos.runs.start({
      taskId: tasks[0]!.id,
      engine: "claude",
      acpSession: "sess-42",
    });
    repos.tasks.setStatus(tasks[0]!.id, "running");

    const report = recoverInterrupted(repos);
    expect(report.runs).toBe(1);
    expect(report.chainsPaused).toEqual([chain.id]);
    expect(repos.runs.getOrThrow(run.id).status).toBe("interrupted");
    expect(repos.tasks.getOrThrow(tasks[0]!.id).status).toBe("interrupted");
    expect(repos.chains.getOrThrow(chain.id).status).toBe("paused");

    const events = repos.events.listByRun(run.id).map((e) => e.type);
    expect(events).toContain("run.state");
    expect(events).toContain("task.state");
    // The stored ACP session must survive for a manual resume.
    const payload = JSON.parse(repos.events.listByRun(run.id)[0]!.payload) as {
      acpSession: string;
    };
    expect(payload.acpSession).toBe("sess-42");

    // Idempotent: a second pass finds nothing.
    expect(recoverInterrupted(repos).runs).toBe(0);
  });
});

describe("managed docs", () => {
  it("replaces only the managed block and appends it when absent", () => {
    const withMarkers = `intro\n<!-- lightsout:begin -->\nold\n<!-- lightsout:end -->\noutro`;
    const updated = replaceManagedBlock(withMarkers, "new state");
    expect(updated).toContain("intro");
    expect(updated).toContain("outro");
    expect(updated).toContain("new state");
    expect(updated).not.toContain("old");

    const without = replaceManagedBlock("# STATE\n\nfree text", "block");
    expect(without).toContain("free text");
    expect(without).toContain("<!-- lightsout:begin -->");
  });

  it("flips plan checkboxes by task id only", () => {
    const plan = [planLine({ id: "t1", title: "one" } as never, false), "- [ ] unrelated"].join(
      "\n",
    );
    const ticked = flipPlanCheckbox(plan, "t1", true);
    expect(ticked).toContain("- [x] one");
    expect(ticked).toContain("- [ ] unrelated");
    expect(flipPlanCheckbox(ticked, "t1", false)).toContain("- [ ] one");
  });

  it("builds the state block from the database", () => {
    const { project, chain, tasks } = seedChain();
    repos.tasks.setStatus(tasks[0]!.id, "ok");
    repos.decisions.record({
      projectId: project.id,
      kind: "human",
      question: "sync strategy?",
      choice: "incremental",
    });
    const run = repos.runs.start({ taskId: tasks[1]!.id, engine: "claude" });
    repos.doubts.open({
      projectId: project.id,
      taskId: tasks[1]!.id,
      runId: run.id,
      kind: "functional",
      context: "c",
      blocks: "b",
      options: [
        { id: "A", text: "x" },
        { id: "B", text: "y" },
      ],
    });

    const block = new ProjectDocs(repos, project).buildStateBlock(chain);
    expect(block).toContain('chain "Offline sync" 1/3');
    expect(block).toContain("Last: one");
    expect(block).toContain("Next: two");
    expect(block).toContain("Last decision: incremental (human,");
    expect(block).toContain("Open doubts: D-1");
  });

  it("names the blocking task when the chain is stuck", () => {
    const { project, chain, tasks } = seedChain();
    repos.tasks.setStatus(tasks[0]!.id, "verify_failed");
    const block = new ProjectDocs(repos, project).buildStateBlock(chain);
    expect(block).toContain("blocked on: one (verify_failed)");
  });

  describe("on disk", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "lo-proj-"));
      await mkdir(path.join(dir, "doc"), { recursive: true });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes STATE.md, syncs PLAN.md and appends decisions and questions", async () => {
      const { project, chain, tasks } = seedChain(dir);
      const docs = new ProjectDocs(repos, project);
      await writeFile(
        path.join(dir, "doc", "STATE.md"),
        "# STATE\n\nHand-written notes stay.\n",
        "utf8",
      );

      await docs.updateState(chain);
      const state = await readFile(path.join(dir, "doc", "STATE.md"), "utf8");
      expect(state).toContain("Hand-written notes stay.");
      expect(state).toContain('chain "Offline sync" 0/3');

      await docs.syncPlan(chain);
      let plan = await readFile(path.join(dir, "doc", "PLAN.md"), "utf8");
      expect(plan.match(/- \[ \]/g)).toHaveLength(3);

      repos.tasks.setStatus(tasks[0]!.id, "ok");
      await docs.syncPlan(chain);
      plan = await readFile(path.join(dir, "doc", "PLAN.md"), "utf8");
      expect(plan).toContain("- [x] one");
      expect(plan.match(/<!-- lo:/g)).toHaveLength(3); // no duplicated lines

      await docs.appendDecision({
        kind: "human",
        question: "push policy?",
        choice: "manual",
        rationale: "pilot",
      });
      const decisions = await readFile(path.join(dir, "doc", "DECISIONS.md"), "utf8");
      expect(decisions).toContain("## push policy?");
      expect(decisions).toContain("Decision: manual (human,");

      await docs.appendQuestion({
        ref: "D-1",
        context: "ambiguous",
        blocks: "task two",
        options: [{ id: "A", text: "one way" }],
        recommendation: "A",
      });
      const questions = await readFile(path.join(dir, "doc", "QUESTIONS.md"), "utf8");
      expect(questions).toContain("### D-1 — open");
      expect(questions).toContain("- Option A: one way");
      expect(questions).toContain("@DOUBT-OPEN D-1");
    });
  });
});

describe("verify gate", () => {
  let dir: string;
  let runId: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lo-verify-"));
    const { tasks } = seedChain(dir);
    runId = repos.runs.start({ taskId: tasks[0]!.id, engine: "claude" }).id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("skips when no command is configured (OR-04)", async () => {
    const result = await runVerify({ repos, runId, cwd: dir, command: "" });
    expect(result).toMatchObject({ ran: false, exitCode: 0 });
    expect(repos.events.listByRun(runId)).toHaveLength(0);
  });

  it("passes, fails and records both events with output", async () => {
    const green = await runVerify({ repos, runId, cwd: dir, command: "echo all good" });
    expect(green).toMatchObject({ ran: true, exitCode: 0 });
    expect(green.tailOutput).toContain("all good");

    const red = await runVerify({
      repos,
      runId,
      cwd: dir,
      command: "echo boom >&2; exit 3",
    });
    expect(red.exitCode).toBe(3);
    expect(red.tailOutput).toContain("boom");

    const types = repos.events.listByRun(runId).map((e) => e.type);
    expect(types.filter((t) => t === "verify.start")).toHaveLength(2);
    expect(types.filter((t) => t === "verify.result")).toHaveLength(2);
  });

  it("runs in the project directory", async () => {
    await writeFile(path.join(dir, "marker.txt"), "x", "utf8");
    const result = await runVerify({ repos, runId, cwd: dir, command: "ls marker.txt" });
    expect(result.exitCode).toBe(0);
  });

  it("kills a command that overruns its timeout", async () => {
    const result = await runVerify({
      repos,
      runId,
      cwd: dir,
      command: "sleep 5",
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });
});

describe("chain loop", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lo-chain-"));
    await mkdir(path.join(dir, "doc"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A runner that always succeeds and records which tasks it was asked to run. */
  function fakeRunner(repos: Repos, ran: string[]) {
    return {
      run: async (input: { project: { id: string }; task: { id: string } }) => {
        ran.push(input.task.id);
        const run = repos.runs.start({ taskId: input.task.id, engine: "claude" });
        repos.runs.finish(run.id, { status: "ok", summary: "done" });
        repos.tasks.setStatus(input.task.id, "ok");
        return {
          runId: run.id,
          outcome: {
            status: "ok" as const,
            summary: "done",
            exitReason: "finished",
            sentinelMissing: false,
          },
        };
      },
    };
  }

  async function orchestrator(verify: string, ran: string[]) {
    const { Orchestrator } = await import("../src/orchestrator/orchestrator.js");
    const { loadConfig } = await import("../src/config.js");
    const { createBus } = await import("../src/bus.js");
    const config = loadConfig({ LO_WORKSPACE: dir, LO_DB: ":memory:", LO_MAX_PARALLEL: "2" });
    const project = repos.projects.create({
      id: "chainy",
      name: "Chainy",
      path: dir,
      verifyCmd: verify,
    });
    const agents = { profileOrThrow: () => undefined } as never;
    return {
      project,
      orch: new Orchestrator(config, repos, createBus(), agents, fakeRunner(repos, ran) as never),
    };
  }

  it("runs a chain in order and completes it (OR-02)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "three",
      tasks: ["a", "b", "c"].map((t) => ({ title: t, spec: t, agentId: "builder" })),
    });
    expect(launch.started).toBe(true);
    await orch.idle();

    expect(ran).toEqual(launch.taskIds);
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("completed");
  });

  it("pauses the chain when the verify gate fails and never starts the next task (OR-04, OR-05)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("exit 3", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "gated",
      tasks: ["first", "second"].map((t) => ({ title: t, spec: t, agentId: "builder" })),
    });
    await orch.idle();

    expect(ran).toHaveLength(1);
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("paused");
    expect(repos.tasks.getOrThrow(launch.taskIds[0]!).status).toBe("verify_failed");
    expect(repos.tasks.getOrThrow(launch.taskIds[1]!).status).toBe("queued");

    const failedRun = repos.runs.listByTask(launch.taskIds[0]!)[0]!;
    expect(failedRun.exit_reason).toContain("verify exit 3");
    const types = repos.events.listByRun(failedRun.id).map((e) => e.type);
    expect(types).toContain("verify.result");
  });

  it("resumes a paused chain when the blocking task is retried (OR-05)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("exit 3", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "gated",
      tasks: ["first", "second"].map((t) => ({ title: t, spec: t, agentId: "builder" })),
    });
    await orch.idle();
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("paused");

    // Fix the gate, then retry: the chain must move on by itself.
    repos.projects.update(project.id, { verifyCmd: "" });
    expect(orch.retryTask(launch.taskIds[0]!)).toBe(true);
    await orch.idle();

    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("completed");
    expect(ran).toHaveLength(3); // first (again), first, second
  });

  it("survives a runner that throws instead of returning an outcome", async () => {
    // The real failure: an adapter died, the ACP SDK rejected a promise, and because `drive` is
    // started and not awaited the rejection killed the whole process. One task may fail; the
    // orchestrator must stay up and say why.
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    const exploding = {
      run: async (input: { task: { id: string } }) => {
        ran.push(input.task.id);
        const run = repos.runs.start({ taskId: input.task.id, engine: "claude" });
        repos.tasks.setStatus(input.task.id, "running");
        void run;
        throw new Error("ACP connection closed");
      },
    };
    (orch as unknown as { runner: unknown }).runner = exploding;

    const launch = orch.launchChain({
      projectId: project.id,
      title: "boom",
      tasks: ["first", "second"].map((t) => ({ title: t, spec: t, agentId: "builder" })),
    });
    // The promise the orchestrator holds must resolve, never reject.
    await expect(orch.idle()).resolves.toBeUndefined();

    expect(ran).toHaveLength(1); // the second task was never started
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("paused");
    expect(repos.tasks.getOrThrow(launch.taskIds[0]!).status).toBe("error");
    // The open run row is closed, so nothing is left looking alive.
    const run = repos.runs.listByTask(launch.taskIds[0]!)[0]!;
    expect(run.status).toBe("error");
    expect(run.error).toContain("ACP connection closed");
    // And the reason is on the timeline, not only in the container log.
    const reasons = repos.events.listAfter(0, 200).map((e) => JSON.stringify(e.payload));
    expect(reasons.some((p) => p.includes("ACP connection closed"))).toBe(true);
  });

  it("puts a paused chain back to work without redoing finished tasks (OR-05)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "interrupted",
      tasks: ["first", "second"].map((t) => ({ title: t, spec: t, agentId: "builder" })),
    });
    await orch.idle();
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("completed");

    // Simulate what a container restart leaves behind: the second task interrupted, chain paused.
    repos.tasks.setStatus(launch.taskIds[1]!, "interrupted");
    repos.chains.setStatus(launch.chainId, "paused");
    ran.length = 0;

    const resumed = orch.resumeChain(launch.chainId);
    expect(resumed.requeued).toEqual([launch.taskIds[1]]);
    expect(resumed.started).toBe(true);
    await orch.idle();

    expect(ran).toEqual([launch.taskIds[1]]); // the finished task was left alone
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("completed");
  });

  it("refuses to resume a completed chain and is a no-op on an active one", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "done",
      tasks: [{ title: "only", spec: "only", agentId: "builder" }],
    });
    await orch.idle();
    expect(() => orch.resumeChain(launch.chainId)).toThrow(/already completed/);

    repos.chains.setStatus(launch.chainId, "active");
    expect(orch.resumeChain(launch.chainId).requeued).toEqual([]);
  });

  it("queues instead of rejecting when the project is busy (OR-08, SR-07)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Replace the runner with one that blocks on the first task.
    const slow = {
      run: async (input: { task: { id: string } }) => {
        ran.push(input.task.id);
        await gate;
        const run = repos.runs.start({ taskId: input.task.id, engine: "claude" });
        repos.runs.finish(run.id, { status: "ok" });
        repos.tasks.setStatus(input.task.id, "ok");
        return {
          runId: run.id,
          outcome: {
            status: "ok" as const,
            summary: "",
            exitReason: "finished",
            sentinelMissing: false,
          },
        };
      },
    };
    const { Orchestrator } = await import("../src/orchestrator/orchestrator.js");
    const { loadConfig } = await import("../src/config.js");
    const { createBus } = await import("../src/bus.js");
    const config = loadConfig({ LO_WORKSPACE: dir, LO_DB: ":memory:" });
    const busy = new Orchestrator(
      config,
      repos,
      createBus(),
      { profileOrThrow: () => undefined } as never,
      slow as never,
    );

    const first = busy.launchChain({
      projectId: project.id,
      title: "long",
      tasks: [{ title: "long task", spec: "s", agentId: "builder" }],
    });
    expect(first.started).toBe(true);

    const second = busy.launchTask({
      projectId: project.id,
      title: "queued task",
      spec: "s",
      agentId: "builder",
      chainId: first.chainId,
    });
    expect(second).toMatchObject({ started: false, queued: true });
    expect(repos.tasks.getOrThrow(second.taskIds[0]!).status).toBe("queued");

    release?.();
    await busy.idle();
    expect(orch).toBeDefined();
  });

  it("aborts a chain and drops its queued tasks (OR-06)", async () => {
    const ran: string[] = [];
    const { project, orch } = await orchestrator("", ran);
    const launch = orch.launchChain({
      projectId: project.id,
      title: "doomed",
      tasks: [{ title: "one", spec: "s", agentId: "builder" }],
    });
    await orch.idle();

    const extra = orch.launchTask({
      projectId: project.id,
      title: "later",
      spec: "s",
      agentId: "builder",
      chainId: launch.chainId,
    });
    const { aborted } = await orch.abortChain(launch.chainId);
    expect(repos.chains.getOrThrow(launch.chainId).status).toBe("aborted");
    // The task may already have run; if it was still queued it must now be aborted.
    const status = repos.tasks.getOrThrow(extra.taskIds[0]!).status;
    expect(["aborted", "ok"]).toContain(status);
    expect(aborted.length).toBeLessThanOrEqual(1);
    // Let any in-flight driver settle before the temp directory is removed.
    await orch.idle();
  });
});

describe("project config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lo-cfg-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when the file is missing", async () => {
    const { config, pack } = await readProjectConfig(dir);
    expect(config).toMatchObject({ verify: "", push: "manual", remote: "" });
    expect(pack).toBeUndefined();
  });

  it("parses the file and exposes the inline policy override as a pack (PE-05)", async () => {
    await writeFile(
      path.join(dir, "lightsout.yaml"),
      [
        "name: Consultant Portal",
        'verify: "npm test"',
        "push: auto",
        "remote: git@example.com:group/portal.git",
        "policy:",
        "  rules: [ { class: deps_install, verdict: allow } ]",
      ].join("\n"),
      "utf8",
    );
    const { config, pack } = await readProjectConfig(dir);
    expect(config).toMatchObject({ verify: "npm test", push: "auto" });
    expect(pack?.id).toBe("project");
    expect(pack?.rules[0]).toMatchObject({ class: "deps_install", verdict: "allow" });
  });

  it("rejects an unknown key instead of ignoring it", async () => {
    await writeFile(path.join(dir, "lightsout.yaml"), "nam: typo\n", "utf8");
    await expect(readProjectConfig(dir)).rejects.toThrow();
  });
});
