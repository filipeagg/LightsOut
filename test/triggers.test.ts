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
import {
  cronToSchedule,
  describeCronPlainly,
  describeSchedule,
  scheduleToCron,
} from "../src/triggers/schedule.js";
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

describe("saying when, without knowing cron (TR-08)", () => {
  it("turns each shape into the cron it means", () => {
    expect(scheduleToCron({ unit: "minutes", every: 15 })).toBe("*/15 * * * *");
    expect(scheduleToCron({ unit: "minutes", every: 1 })).toBe("* * * * *");
    expect(scheduleToCron({ unit: "hours", every: 2, minute: 30 })).toBe("30 */2 * * *");
    expect(scheduleToCron({ unit: "hours", every: 1, minute: 0 })).toBe("0 * * * *");
    expect(scheduleToCron({ unit: "days", every: 1, hour: 7, minute: 0 })).toBe("0 7 * * *");
    expect(scheduleToCron({ unit: "days", every: 3, hour: 7, minute: 0 })).toBe("0 7 */3 * *");
    expect(
      scheduleToCron({ unit: "weeks", weekdays: [1, 2, 3, 4, 5], hour: 7, minute: 0 }),
    ).toBe("0 7 * * 1,2,3,4,5");
    expect(scheduleToCron({ unit: "months", dayOfMonth: 1, hour: 9, minute: 0 })).toBe("0 9 1 * *");
    expect(scheduleToCron({ unit: "custom", cron: "0 7 * * 1-5" })).toBe("0 7 * * 1-5");
  });

  it("refuses a shape it cannot honour, in the caller's words", () => {
    expect(() => scheduleToCron({ unit: "minutes", every: 0 })).toThrow(/minutes between runs/);
    expect(() => scheduleToCron({ unit: "hours", every: 2, minute: 99 })).toThrow(/minute/);
    expect(() => scheduleToCron({ unit: "weeks", weekdays: [], hour: 7, minute: 0 })).toThrow(
      /at least one day/,
    );
    expect(() => scheduleToCron({ unit: "custom", cron: "nope" })).toThrow(/five fields/);
  });

  it("reads a stored cron back into the shape it came from", () => {
    for (const schedule of [
      { unit: "minutes", every: 15 },
      { unit: "hours", every: 2, minute: 30 },
      { unit: "days", every: 1, hour: 7, minute: 0 },
      { unit: "days", every: 3, hour: 7, minute: 0 },
      { unit: "weeks", weekdays: [1, 3, 5], hour: 18, minute: 45 },
      { unit: "months", dayOfMonth: 1, hour: 9, minute: 0 },
    ] as const) {
      expect(cronToSchedule(scheduleToCron(schedule))).toEqual(schedule);
    }
  });

  it("opens as custom what the shapes cannot say, rather than rounding it", () => {
    // A cron with two hours, two days of the month and a weekday: no shape means this.
    expect(cronToSchedule("0 9,17 1,15 * 2").unit).toBe("custom");
    expect(cronToSchedule("0 9 * 3 *").unit).toBe("custom");
    expect(cronToSchedule("0 7 * * 1-5").unit).toBe("custom"); // a range, not a list
    expect(cronToSchedule("nonsense").unit).toBe("custom");
  });

  it("says what it means in a sentence", () => {
    expect(describeSchedule({ unit: "days", every: 1, hour: 7, minute: 0 }).text).toBe(
      "every day at 07:00",
    );
    expect(
      describeSchedule({ unit: "weeks", weekdays: [1, 2, 3, 4, 5], hour: 7, minute: 0 }).text,
    ).toBe("every weekday at 07:00");
    expect(describeSchedule({ unit: "weeks", weekdays: [0, 6], hour: 10, minute: 30 }).text).toBe(
      "at weekends at 10:30",
    );
    expect(describeSchedule({ unit: "minutes", every: 15 }).text).toBe("every 15 minutes");
    expect(describeSchedule({ unit: "months", dayOfMonth: 1, hour: 9, minute: 5 }).text).toBe(
      "on day 1 of every month at 09:05",
    );
  });

  it("warns when a step is not the even rhythm it looks like", () => {
    // */7 fires at :00 :07 … :56 and then jumps four minutes. Saying "every 7 minutes" would be
    // a comfortable lie, and the person finds out at 03:00.
    expect(describeSchedule({ unit: "minutes", every: 7 }).caveat).toMatch(/jumps/);
    expect(describeSchedule({ unit: "minutes", every: 15 }).caveat).toBeUndefined();
    expect(describeSchedule({ unit: "days", every: 3, hour: 7, minute: 0 }).caveat).toMatch(
      /restarts on the 1st/,
    );
  });

  it("describes what is stored, whichever way it was written", () => {
    expect(describeCronPlainly("0 7 * * 1,2,3,4,5").text).toBe("every weekday at 07:00");
    expect(describeCronPlainly("*/30 * * * *").text).toBe("every 30 minutes");
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

/**
 * TR-09: a person pressed a button, so the answer is the work or the reason — never a promise.
 */
describe("firing one by hand", () => {
  it("launches now, outside its schedule, and records the firing", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId, "0 3 * * *"); // nowhere near now
    const { scheduler, launches } = schedulerWith();

    const outcome = await scheduler.fireNow(id, "panel");
    expect(outcome.fired).toBe(true);
    expect(outcome.result).toMatch(/by hand \(panel\)/);
    expect(launches).toEqual([`task:${projectId}:builder`]);
    // It is a firing, so catch-up must not run the same slot again later (TR-04).
    expect(repos.triggers.getOrThrow(id).last_fired_at).toBeTruthy();
  });

  it("fires a disabled trigger, because that is what makes disabling safe", async () => {
    const projectId = aProject();
    const id = aTrigger(projectId);
    repos.triggers.update(id, { enabled: false });
    const { scheduler, launches } = schedulerWith();

    expect((await scheduler.fireNow(id, "mcp")).fired).toBe(true);
    expect(launches).toHaveLength(1);
  });

  it("refuses with the reason instead of queueing behind a run in flight (TR-03)", async () => {
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
    const outcome = await scheduler.fireNow(id, "panel");
    expect(outcome.fired).toBe(false);
    expect(outcome.result).toMatch(/already in flight/);
    expect(launches).toEqual([]);
  });

  it("says so when the trigger is gone", async () => {
    const { scheduler } = schedulerWith();
    await expect(scheduler.fireNow("01NOSUCHTRIGGER", "mcp")).rejects.toThrow(/trigger not found/);
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
