/**
 * Saying when something runs, without knowing cron (TR-08, DESIGN §16b.1).
 *
 * Five shapes cover what people actually schedule; cron stays underneath as the one stored truth,
 * so there is never a second field to disagree with it. The conversion lives here rather than in
 * the panel because both surfaces have to produce the same row from the same choice.
 */
import { describeCron, parseCron } from "./cron.js";

export type Schedule =
  | { unit: "minutes"; every: number }
  | { unit: "hours"; every: number; minute: number }
  | { unit: "days"; every: number; hour: number; minute: number }
  | { unit: "weeks"; weekdays: number[]; hour: number; minute: number }
  | { unit: "months"; dayOfMonth: number; hour: number; minute: number }
  | { unit: "custom"; cron: string };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function whole(value: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${what} must be a whole number between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/** The stored form of a schedule. Throws with the field that is wrong, in the caller's words. */
export function scheduleToCron(schedule: Schedule): string {
  switch (schedule.unit) {
    case "minutes": {
      const every = whole(schedule.every, 1, 59, "minutes between runs");
      return every === 1 ? "* * * * *" : `*/${every} * * * *`;
    }
    case "hours": {
      const every = whole(schedule.every, 1, 23, "hours between runs");
      const minute = whole(schedule.minute, 0, 59, "minute");
      return every === 1 ? `${minute} * * * *` : `${minute} */${every} * * *`;
    }
    case "days": {
      const every = whole(schedule.every, 1, 31, "days between runs");
      const hour = whole(schedule.hour, 0, 23, "hour");
      const minute = whole(schedule.minute, 0, 59, "minute");
      return every === 1 ? `${minute} ${hour} * * *` : `${minute} ${hour} */${every} * *`;
    }
    case "weeks": {
      const hour = whole(schedule.hour, 0, 23, "hour");
      const minute = whole(schedule.minute, 0, 59, "minute");
      const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
      if (days.length === 0) throw new Error("choose at least one day of the week");
      for (const day of days) whole(day, 0, 6, "day of the week");
      return `${minute} ${hour} * * ${days.join(",")}`;
    }
    case "months": {
      const day = whole(schedule.dayOfMonth, 1, 28, "day of the month");
      const hour = whole(schedule.hour, 0, 23, "hour");
      const minute = whole(schedule.minute, 0, 59, "minute");
      return `${minute} ${hour} ${day} * *`;
    }
    case "custom":
      // Parsed, not trusted: an expression that does not parse never reaches the database.
      return parseCron(schedule.cron).expression;
  }
}

const NUMBER = /^\d+$/;
const STEP = /^\*\/(\d+)$/;
const LIST = /^\d+(,\d+)*$/;

/**
 * Read a stored cron back into a shape, when it is one (TR-08).
 *
 * Best-effort on purpose. Anything the five shapes cannot say — two hours on the 1st and 15th of
 * every other month — comes back as `custom`, because opening it in a picker that cannot express
 * it would quietly change what it means the moment someone pressed save.
 */
export function cronToSchedule(cron: string): Schedule {
  let parts: string[];
  try {
    parts = parseCron(cron).expression.split(/\s+/);
  } catch {
    return { unit: "custom", cron };
  }
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  const custom: Schedule = { unit: "custom", cron };
  if (mon !== "*") return custom;

  const stepOf = (field: string): number | undefined => {
    const match = STEP.exec(field);
    return match ? Number(match[1]) : undefined;
  };

  // Every N minutes: nothing else may be restricted.
  if ((min === "*" || stepOf(min) !== undefined) && hr === "*" && dom === "*" && dow === "*") {
    return { unit: "minutes", every: min === "*" ? 1 : stepOf(min)! };
  }
  if (!NUMBER.test(min)) return custom;
  const minute = Number(min);

  // Every N hours at a minute.
  if ((hr === "*" || stepOf(hr) !== undefined) && dom === "*" && dow === "*") {
    return { unit: "hours", every: hr === "*" ? 1 : stepOf(hr)!, minute };
  }
  if (!NUMBER.test(hr)) return custom;
  const hour = Number(hr);

  // Weekdays at a time.
  if (dom === "*" && dow !== "*") {
    if (!LIST.test(dow)) return custom;
    const weekdays = dow.split(",").map(Number).map((d) => (d === 7 ? 0 : d));
    if (weekdays.some((d) => d < 0 || d > 6)) return custom;
    return { unit: "weeks", weekdays, hour, minute };
  }
  if (dow !== "*") return custom;

  // Every day, every N days, or a day of the month.
  if (dom === "*") return { unit: "days", every: 1, hour, minute };
  const step = stepOf(dom);
  if (step !== undefined) return { unit: "days", every: step, hour, minute };
  if (NUMBER.test(dom) && Number(dom) >= 1 && Number(dom) <= 28) {
    return { unit: "months", dayOfMonth: Number(dom), hour, minute };
  }
  return custom;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The values a step actually lands on, when the step does not divide its field evenly. */
function stepReality(step: number, max: number, unit: string): string | undefined {
  if (step <= 1 || (max + 1) % step === 0) return undefined;
  const hits: number[] = [];
  for (let v = 0; v <= max; v += step) hits.push(v);
  return (
    `careful: it fires at ${unit} ${hits.slice(0, 4).join(", ")}… ${hits[hits.length - 1]}, ` +
    `then jumps — a step is a step, not an even rhythm`
  );
}

/**
 * What a schedule means, in a sentence, plus the caveat when a step does not divide evenly
 * (TR-08). Written for the person about to press save, not for a log.
 */
export function describeSchedule(schedule: Schedule): { text: string; caveat?: string } {
  switch (schedule.unit) {
    case "minutes": {
      const text =
        schedule.every === 1 ? "every minute" : `every ${schedule.every} minutes`;
      const caveat = stepReality(schedule.every, 59, "minute");
      return caveat ? { text, caveat } : { text };
    }
    case "hours": {
      const at = `at minute ${schedule.minute}`;
      const text =
        schedule.every === 1 ? `every hour, ${at}` : `every ${schedule.every} hours, ${at}`;
      const caveat = stepReality(schedule.every, 23, "hour");
      return caveat ? { text, caveat } : { text };
    }
    case "days": {
      const at = `at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
      if (schedule.every === 1) return { text: `every day ${at}` };
      return {
        text: `every ${schedule.every} days ${at}`,
        caveat:
          "careful: cron counts days within each month, so this restarts on the 1st — " +
          `it fires on days 1, ${1 + schedule.every}, ${1 + schedule.every * 2}… of every month`,
      };
    }
    case "weeks": {
      const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b);
      const named =
        days.length === 7
          ? "every day"
          : days.join(",") === "1,2,3,4,5"
            ? "every weekday"
            : days.join(",") === "0,6"
              ? "at weekends"
              : days.map((d) => DAY_NAMES[d]).join(", ");
      return { text: `${named} at ${pad(schedule.hour)}:${pad(schedule.minute)}` };
    }
    case "months":
      return {
        text: `on day ${schedule.dayOfMonth} of every month at ${pad(schedule.hour)}:${pad(schedule.minute)}`,
      };
    case "custom":
      // No shape says this, so the reading is field by field. Still better than nothing in front
      // of someone about to save it.
      try {
        return { text: describeCron(schedule.cron) };
      } catch {
        return { text: `cron: ${schedule.cron}` };
      }
  }
}

/** The same sentence, from what is stored. This is what the panel and the tools print. */
export function describeCronPlainly(cron: string): { text: string; caveat?: string } {
  return describeSchedule(cronToSchedule(cron));
}
