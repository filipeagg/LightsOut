/**
 * The scheduler (TR-01..07, DESIGN §16b).
 *
 * It knows two things and nothing else: which minute it is, and which triggers name that minute.
 * What to launch, whether the project is busy, what the agent is — all of that belongs to the
 * orchestrator and is reached through the same `Actions` the panel and MCP use. A scheduler that
 * knew how to run work would be a second orchestrator, and the two would disagree by Christmas.
 */
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { TriggerRow } from "../db/repos/triggers.js";
import type { Actions } from "../control/actions.js";
import { matches, nextFire, parseCron, previousFire } from "./cron.js";

/** How often the clock is looked at. Half a minute, so a minute is never stepped over. */
export const TICK_MS = 30_000;

export type FiringOutcome = {
  triggerId: string;
  fired: boolean;
  /** One line: what it launched, or why it did not (TR-05). */
  result: string;
};

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  /** The minute already handled, so two ticks in the same minute fire once. */
  private lastMinute = "";

  constructor(
    private readonly repos: Repos,
    private readonly actions: Actions,
    private readonly bus: Bus,
  ) {}

  /** The next time this trigger would fire, for the panel (TR-06). Null when it never will. */
  nextFireAt(trigger: TriggerRow, from = new Date()): Date | null {
    try {
      return nextFire(parseCron(trigger.cron), from);
    } catch {
      return null;
    }
  }

  /**
   * At boot: a slot that passed while the container was off, and nothing ran in it, runs once
   * (TR-04). Only the most recent slot — five missed days is a reason to look, not to run five
   * times — and never a slot older than the trigger itself.
   */
  async catchUp(now = new Date()): Promise<FiringOutcome[]> {
    const outcomes: FiringOutcome[] = [];
    for (const trigger of this.repos.triggers.listEnabled()) {
      let slot: Date | null = null;
      try {
        slot = previousFire(parseCron(trigger.cron), now);
      } catch (err) {
        outcomes.push(this.record(trigger, now, `invalid cron: ${message(err)}`, false));
        continue;
      }
      if (!slot) continue;
      if (slot.toISOString() <= trigger.created_at) continue;
      if (trigger.last_fired_at && trigger.last_fired_at >= slot.toISOString()) continue;
      outcomes.push(await this.fire(trigger, slot, "catch-up"));
    }
    return outcomes;
  }

  /** One tick. Exported for the tests, which do not want to wait thirty seconds. */
  async tick(now = new Date()): Promise<FiringOutcome[]> {
    const minute = now.toISOString().slice(0, 16);
    if (minute === this.lastMinute) return [];
    this.lastMinute = minute;

    const outcomes: FiringOutcome[] = [];
    for (const trigger of this.repos.triggers.listEnabled()) {
      let due = false;
      try {
        due = matches(parseCron(trigger.cron), now);
      } catch (err) {
        // An unparseable cron is recorded once per minute it would have run, not every tick.
        outcomes.push(this.record(trigger, now, `invalid cron: ${message(err)}`, false));
        continue;
      }
      if (!due) continue;
      outcomes.push(await this.fire(trigger, now, "on time"));
    }
    return outcomes;
  }

  /**
   * Fire one now, because somebody pressed the button (TR-09).
   *
   * The same path the clock takes, including the three refusals: a manual firing that queued behind
   * a run in flight would be the one case where "run it now" means "run it at some point", and a
   * person watching a button is the worst audience for that. Disabled triggers may still be fired
   * by hand — that is what makes disabling safe to do while testing one.
   */
  async fireNow(triggerId: string, actor: string): Promise<FiringOutcome> {
    const trigger = this.repos.triggers.getOrThrow(triggerId);
    return this.fire(trigger, new Date(), `by hand (${actor})`);
  }

  /**
   * Launch, or say why not. The three refusals (TR-03) are checked here rather than left to the
   * orchestrator, because "queued behind yesterday's digest" is not what a person means by a
   * daily trigger.
   */
  private async fire(trigger: TriggerRow, at: Date, how: string): Promise<FiringOutcome> {
    const project = this.repos.projects.get(trigger.project_id);
    if (!project) return this.record(trigger, at, "the project is gone", false);
    if (project.archived) return this.record(trigger, at, "skipped: the project is archived", false);

    const busy = this.repos.runs
      .listActive()
      .some((run) => this.repos.tasks.get(run.task_id)?.project_id === project.id);
    if (busy) return this.record(trigger, at, "skipped: a run is already in flight", false);

    const chain = this.repos.chains.latestForProject(project.id);
    if (chain?.status === "paused") {
      return this.record(trigger, at, "skipped: the chain is paused, something needs a person", false);
    }

    try {
      if (trigger.phase_ref) {
        const result = await this.actions.launchPhase("system", project.id, trigger.phase_ref, {
          request: trigger.request,
          expects: trigger.expects,
        });
        return this.record(trigger, at, `${how}: launched phase ${result.phaseRef}`, true);
      }
      const result = await this.actions.launchTask("system", {
        projectId: project.id,
        title: trigger.title ?? trigger.name,
        spec: trigger.request,
        expects: trigger.expects,
        agentId: trigger.agent_id!,
      });
      return this.record(trigger, at, `${how}: launched task ${result.taskId}`, true);
    } catch (err) {
      return this.record(trigger, at, `did not launch: ${message(err)}`, false);
    }
  }

  private record(trigger: TriggerRow, at: Date, result: string, fired: boolean): FiringOutcome {
    this.repos.triggers.recordFiring(trigger.id, at, result);
    this.repos.events.append({
      type: "trigger.fired",
      payload: {
        triggerId: trigger.id,
        name: trigger.name,
        projectId: trigger.project_id,
        fired,
        result,
        at: at.toISOString(),
      },
    });
    this.bus.emit("overview");
    return { triggerId: trigger.id, fired, result };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A failing tick must not take the process down, and must not stop the clock either.
      void this.tick().catch(() => undefined);
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
