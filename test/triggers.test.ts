/**
 * TR-01..07 (§16b): launches with a clock on them.
 *
 * The scheduler is tested by handing it the time rather than by waiting for it. What matters is
 * that it fires on the minute it names, refuses in the three situations that would pile work up,
 * and recovers exactly one missed slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import { createBus } from "../src/bus.js";
import { matches, nextFire, parseCron, previousFire } from "../src/triggers/cron.js";
import { Scheduler } from "../src/triggers/scheduler.js";
import type { Actions } from "../src/control/actions.js";

let db: Db;
let repos: Repos;

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  db = openDb({ file: ":memory:" });
  migrate(db);
  repos = createRepos(db);
});

afterEach(() => db.close());

describe("the cron parser", () => {
  it("reads the five fields, lists, ranges and steps", () => {
    expect(matches(parseCron("0 7 * * 1-5"), at("2026-07-28T07:00:00"))).toBe(true); // Tuesday
    expect(matches(parseCron("0 7 * * 1-5"), at("2026-07-26T07:00:00"))).toBe(false); // Sunday
    expect(matches(parseCron("*/15 * * * *"), at("2026-07-28T09:30:00"))).toBe(true);
    expect(matches(parseCron("*/15 * * * *"), at("2026-07-28T09:31:00"))).toBe(false);
    expect(matches(parseCron("0 9,17 * * *"), at("2026-07-28T17:00:00"))).toBe(true);
  });

  it("takes 7 as Sunday, like 0", () => {
    expect(matches(parseCron("0 7 * * 7"), at("2026-07-26T07:00:00"))).toBe(true);
  });

  it("refuses what it cannot honour, naming the field", () => {
    expect(() => parseCron("0 7 * *")).toThrow(/five fields/);
    expect(() => parseCron("0 99 * * *")).toThrow(/hour/);
    expect(() => parseCron("0 7 * * abc")).toThrow(/day of week/);
    expect(() => parseCron("*/0 7 * * *")).toThrow(/step/);
  });

  it("finds the next and the previous slot", () => {
    const fields = parseCron("0 7 * * 1-5");
    expect(nextFire(fields, at("2026-07-28T08:00:00"))?.toISOString().slice(0, 16)).toBe(
      new Date("2026-07-29T07:00:00").toISOString().slice(0, 16),
    );
    expect(previousFire(fields, at("2026-07-28T08:00:00"))?.toISOString().slice(0, 16)).toBe(
      new Date("2026-07-28T07:00:00").toISOString().slice(0, 16),
    );
  });
});

/** A scheduler whose launches are recorded instead of run. */
function schedulerWith(): { scheduler: Scheduler; launches: string[] } {
  const launches: string[] = [];
  const actions = {
    launchPhase: async (_actor: string, projectId: string, phase: string) => {
      launches.push(`phase:${projectId}:${phase}`);
      return { phaseId: "p", phaseRef: phase, taskId: "t", started: true };
    },
    launchTask: async (_actor: string, input: { projectId: string; agentId: string }) => {
      launches.push(`task:${input.projectId}:${input.agentId}`);
      return { taskId: "t", chainId: "c", started: true, queued: false };
    },
  } as unknown as Actions;
  return { scheduler: new Scheduler(repos, actions, createBus()), launches };
}

function aProject(id = "digest"): string {
  repos.projects.create({
    id,
    name: id,
    path: `/workspace/projects/${id}`,
    context: "goal: be triggered",
  });
  return id;
}

function aTrigger(projectId: string, cron = "0 7 * * *"): string {
  return repos.triggers.create({
    projectId,
    name: "daily",
    cron,
    agentId: "builder",
    request: "collect yesterday's items",
    expects: "the base updated",
    createdBy: "panel",
  }).id;
}

describe("the scheduler", () => {
  it("fires on the minute it names, and not twice in the same minute", async () => {
    const projectId = aProject();
    aTrigger(projectId);
    const { scheduler, launches } = schedulerWith();

    expect(await scheduler.tick(at("2026-07-28T06:59:00"))).toEqual([]);
    const fired = await scheduler.tick(at("2026-07-28T07:00:00"));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.fired).toBe(true);
    expect(launches).toEqual([`task:${projectId}:builder`]);

    // The clock ticks every 30 s: the second tick of the same minute must do nothing.
    expect(await scheduler.tick(at("2026-07-28T07:00:30"))).toEqual([]);
    expect(launches).toHaveLength(1);
  });

  it("skips rather than queues when a run of that project is in flight (TR-03)", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    const chain = repos.chains.create({ projectId, title: "c" });
    const task = repos.tasks.create({
      projectId,
      chainId: chain.id,
      title: "busy",
      spec: "s",
      agentId: "builder",
      position: 1,
    });
    repos.runs.start({ taskId: task.id, engine: "claude" });

    const { scheduler, launches } = schedulerWith();
    const [outcome] = await scheduler.tick(at("2026-07-28T07:00:00"));
    expect(outcome?.fired).toBe(false);
    expect(outcome?.result).toMatch(/already in flight/);
    expect(launches).toEqual([]);
    // TR-05: and it is on the row, not only in the log.
    expect(repos.triggers.getOrThrow(id).last_result).toMatch(/already in flight/);
  });

  it("skips when the chain is paused, because something is waiting for a person (TR-03)", async () => {
    const projectId = aProject();
    aTrigger(projectId);
    const chain = repos.chains.create({ projectId, title: "c" });
    repos.chains.setStatus(chain.id, "paused");

    const { scheduler, launches } = schedulerWith();
    const [outcome] = await scheduler.tick(at("2026-07-28T07:00:00"));
    expect(outcome?.result).toMatch(/paused/);
    expect(launches).toEqual([]);
  });

  it("ignores a disabled trigger and keeps it (TR-01)", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    repos.triggers.update(id, { enabled: false });

    const { scheduler, launches } = schedulerWith();
    expect(await scheduler.tick(at("2026-07-28T07:00:00"))).toEqual([]);
    expect(launches).toEqual([]);
    expect(repos.triggers.get(id)).toBeDefined();
  });

  it("records an unparseable cron instead of throwing at 07:00 (TR-05)", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    // Straight into the row: the action layer would have refused it, which is the point.
    db.prepare("UPDATE triggers SET cron = ? WHERE id = ?").run("nonsense", id);

    const { scheduler } = schedulerWith();
    const [outcome] = await scheduler.tick(at("2026-07-28T07:00:00"));
    expect(outcome?.fired).toBe(false);
    expect(outcome?.result).toMatch(/invalid cron/);
  });
});

describe("a firing missed while the container was off (TR-04)", () => {
  it("runs once, not once per missed day", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    // Created three days ago, so the slots in between were all missed.
    db.prepare("UPDATE triggers SET created_at = ? WHERE id = ?").run(
      "2026-07-25T00:00:00.000Z",
      id,
    );

    const { scheduler, launches } = schedulerWith();
    await scheduler.catchUp(at("2026-07-28T09:00:00"));
    expect(launches).toHaveLength(1);
    expect(repos.triggers.getOrThrow(id).last_result).toMatch(/catch-up/);
  });

  it("does not run a slot that already fired", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    db.prepare("UPDATE triggers SET created_at = ?, last_fired_at = ? WHERE id = ?").run(
      "2026-07-25T00:00:00.000Z",
      new Date("2026-07-28T07:00:00").toISOString(),
      id,
    );

    const { scheduler, launches } = schedulerWith();
    await scheduler.catchUp(at("2026-07-28T09:00:00"));
    expect(launches).toEqual([]);
  });

  it("does not run a slot older than the trigger", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    // Created at 08:00, after today's 07:00 slot: that slot happened before it existed. Written
    // explicitly rather than relying on the real clock, which is not the clock the test hands in.
    db.prepare("UPDATE triggers SET created_at = ? WHERE id = ?").run(
      at("2026-07-28T08:00:00").toISOString(),
      id,
    );

    const { scheduler, launches } = schedulerWith();
    await scheduler.catchUp(at("2026-07-28T09:00:00"));
    expect(launches).toEqual([]);
  });
});
