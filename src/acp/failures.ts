/**
 * What kind of failure just ended a run (§6.9, §11.3, §11.3b).
 *
 * The failure this exists for: three `claude` runs died on the SDK's own words — *"Failed to
 * refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This
 * is usually transient; retry in a minute"* — and every one of them was recorded as a plain
 * `error`. The task spent an attempt on something the agent did not cause, the chain paused, and
 * the panel said "the task failed" where the honest answer was "wait a minute and run it again".
 * A message that tells you what to do is worth reading.
 *
 * Five kinds, because five different things must happen:
 *
 * - `auth`         the credential is gone or refused; only a human reconnecting fixes it (§11.3).
 * - `no_credit`    the account has no credit or quota left; a human must top it up (§11.3b).
 * - `rate_limited` the provider is refusing for now, and usually says for how long.
 * - `transient`    nothing is wrong that waiting will not fix: retry, and do not blame the task.
 * - `error`        everything else, which is the agent's problem or ours.
 *
 * **The order of the tests is not the order of that list, and that is the whole subtlety.**
 * `transient` is tested before `auth` because the refresh-lock message talks about OAuth tokens
 * and signing in: read by the auth patterns it looks like a dead credential, and a person would
 * be sent to reconnect an engine that is perfectly well. The narrow, specific reading wins over
 * the broad one.
 */

export type FailureKind = "auth" | "no_credit" | "rate_limited" | "transient" | "error";

/** No credit, no quota, or a plan that will not carry this request (§11.3b). */
const NO_CREDIT_PATTERNS = [
  /credit balance is too low/i,
  /insufficient (credit|credits|funds|balance|quota)/i,
  /out of credits?\b/i,
  /(exceeded|reached|ran out of)[^.]{0,40}(quota|usage limit|spending limit|credit limit)/i,
  /\b402\b/,
  /payment required/i,
  /billing[^.]{0,30}(required|issue|problem)/i,
  /upgrade your plan/i,
];

/** Refused for now, with a clock attached. */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[ _-]?limit/i,
  /too many requests/i,
];

/**
 * Waiting fixes it. Deliberately specific: anything vague here turns a real bug into an
 * infinite retry, which is a worse failure than the one it hides.
 */
const TRANSIENT_PATTERNS = [
  /refreshing it or exited mid-refresh/i,
  /usually transient/i,
  /retry in a (minute|moment|bit)/i,
  /\b(502|503|504|529)\b/,
  /overloaded/i,
  /temporarily unavailable/i,
  /\b(ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/,
  /socket hang up/i,
  /request timed out/i,
  /ACP connection closed/i,
];

/**
 * Recognise an authentication failure in whatever shape the adapter passed it through (§11.3).
 * Both CLIs surface the provider's own words, so this matches on the words rather than a code:
 * a 401, an expired OAuth token, or a plain "not logged in".
 */
const AUTH_PATTERNS = [
  /\b401\b/,
  /oauth[^.]*token[^.]*(expired|invalid|revoked)/i,
  /failed to authenticate/i,
  /authentication[_ -]?(error|failed|required)/i,
  /\bunauthorized\b/i,
  /not logged in/i,
  /invalid[_ -]api[_ -]key/i,
  /re-?authenticate/i,
];

/**
 * The engine's own refresh lock, named here because the error message does not name it.
 *
 * `claude` coordinates token renewal between parallel processes with a lock under its config
 * directory. A process that dies mid-refresh leaves it behind, and every later refresh then
 * fails with the same sentence for as long as it sits there. LightsOut does not delete another
 * product's files, but it can say how old the lock is, which turns "transient, retrying" into
 * "this one is not going to clear on its own" without anybody guessing.
 */
export const REFRESH_LOCK_PATTERN = /refreshing it or exited mid-refresh/i;
export const REFRESH_LOCK_NAME = ".oauth_refresh.lock";

export function classifyFailure(message: string): FailureKind {
  const text = message ?? "";
  if (!text.trim()) return "error";
  if (NO_CREDIT_PATTERNS.some((p) => p.test(text))) return "no_credit";
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(text))) return "rate_limited";
  // Before auth, on purpose: see the note at the top of this file.
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) return "transient";
  if (AUTH_PATTERNS.some((p) => p.test(text))) return "auth";
  return "error";
}

/** Kept under its own name: §11.3 and the health probe speak of auth, not of kinds. */
export function isAuthFailure(message: string): boolean {
  return classifyFailure(message) === "auth";
}

/** Worth running again without anybody deciding anything. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === "transient" || kind === "rate_limited";
}

/** A failure a person has to act on: the run stops and the chain pauses with a reason. */
export function needsHuman(kind: FailureKind): boolean {
  return kind === "auth" || kind === "no_credit";
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

/**
 * How long the provider asked us to wait, when it said so. Undefined means "no opinion", and the
 * caller's own backoff decides — a provider that names a delay is obeyed, never shortened.
 */
export function retryAfterMs(message: string): number | undefined {
  const text = message ?? "";
  const explicit = /retry[- ]after[:= ]+(\d+)/i.exec(text);
  if (explicit?.[1]) return Number(explicit[1]) * 1000;

  const phrase = /(?:try again|retry|wait)[^.\d]{0,20}(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|[smh])\b/i.exec(
    text,
  );
  if (phrase?.[1] && phrase[2]) {
    const unit = UNIT_MS[phrase[2].toLowerCase()];
    if (unit) return Number(phrase[1]) * unit;
  }

  if (/retry in a minute/i.test(text)) return 60_000;
  return undefined;
}
