/**
 * Five-field cron, parsed here rather than installed (TR-01, DESIGN §16b).
 *
 * `minute hour day-of-month month day-of-week`, with `*`, lists (`1,15`), ranges (`1-5`) and steps
 * (`*\/15`, `1-5/2`). No seconds, no `@daily`, no `L`/`#`: every one of those is a thing to explain
 * in the panel and a thing to get wrong here, and none of them is needed to say "every weekday at
 * seven". Day-of-month and day-of-week are OR-ed when both are restricted, which is what cron does
 * and what surprises people, so it is written down.
 */

export type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Kept as written, for the panel and for round-tripping. */
  expression: string;
};

type Range = { min: number; max: number; name: string };

const RANGES: Range[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  // 7 is Sunday as well as 0: both spellings are in the wild and neither is worth an argument.
  { min: 0, max: 7, name: "day of week" },
];

function parseField(raw: string, range: Range): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [spec, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`${range.name}: step must be a positive whole number, got "${stepRaw}"`);
    }

    let from: number;
    let to: number;
    if (spec === "*" || spec === undefined || spec === "") {
      from = range.min;
      to = range.max;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(spec);
      to = Number(spec);
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`${range.name}: "${part}" is not a number, a range or *`);
    }
    if (from < range.min || to > range.max || from > to) {
      throw new Error(`${range.name}: "${part}" is outside ${range.min}-${range.max}`);
    }
    for (let v = from; v <= to; v += step) values.add(v === 7 && range.name === "day of week" ? 0 : v);
  }
  return values;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `a cron expression has five fields (minute hour day-of-month month day-of-week); ` +
        `got ${parts.length} in "${expression}"`,
    );
  }
  return {
    minute: parseField(parts[0]!, RANGES[0]!),
    hour: parseField(parts[1]!, RANGES[1]!),
    dayOfMonth: parseField(parts[2]!, RANGES[2]!),
    month: parseField(parts[3]!, RANGES[3]!),
    dayOfWeek: parseField(parts[4]!, RANGES[4]!),
    expression: expression.trim(),
  };
}

/** True when this exact minute is one the expression names. */
export function matches(fields: CronFields, at: Date): boolean {
  const domRestricted = fields.dayOfMonth.size !== 31;
  const dowRestricted = fields.dayOfWeek.size !== 7;
  const dom = fields.dayOfMonth.has(at.getDate());
  const dow = fields.dayOfWeek.has(at.getDay());
  // Cron's own rule: both restricted means either may match, which is how "the 1st and every
  // Monday" is expressible at all.
  const day = domRestricted && dowRestricted ? dom || dow : dom && dow;
  return (
    fields.minute.has(at.getMinutes()) &&
    fields.hour.has(at.getHours()) &&
    fields.month.has(at.getMonth() + 1) &&
    day
  );
}

const MINUTE_MS = 60_000;

/** The next minute at or after `from` that the expression names, or null within a year. */
export function nextFire(fields: CronFields, from: Date): Date | null {
  const start = new Date(Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS);
  // A year of minutes is the honest bound: an expression that matches nothing in a year matches
  // nothing worth waiting for, and the loop has to end.
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const at = new Date(start.getTime() + i * MINUTE_MS);
    if (matches(fields, at)) return at;
  }
  return null;
}

/**
 * The most recent minute strictly before `before` that the expression names (TR-04).
 *
 * This is what makes a missed firing recoverable: at boot, if the previous slot is later than the
 * last firing, that slot was missed. Bounded at 32 days back, because a trigger that has not fired
 * in a month is not owed a run, it is owed a look.
 */
export function previousFire(fields: CronFields, before: Date): Date | null {
  const start = new Date(Math.floor(before.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
  for (let i = 0; i < 32 * 24 * 60; i += 1) {
    const at = new Date(start.getTime() - i * MINUTE_MS);
    if (matches(fields, at)) return at;
  }
  return null;
}

/**
 * A field-by-field reading. Kept for diagnosing an expression that does not do what someone
 * expected; what a person is shown is `describeSchedule` in `schedule.ts`, which speaks English
 * (TR-08).
 */
export function describeCron(expression: string): string {
  const fields = parseCron(expression);
  const list = (set: Set<number>, all: number) =>
    set.size === all ? "every" : [...set].sort((a, b) => a - b).join(",");
  const hours = list(fields.hour, 24);
  const minutes = list(fields.minute, 60);
  const days =
    fields.dayOfWeek.size === 7 && fields.dayOfMonth.size === 31
      ? "every day"
      : `days ${list(fields.dayOfMonth, 31)} / weekdays ${list(fields.dayOfWeek, 7)}`;
  return `minute ${minutes}, hour ${hours}, ${days}`;
}
