/**
 * The launch contract (OR-10, DESIGN §10.0b).
 *
 * No agent runs without knowing what is being asked of it *this time* and what is expected back.
 * Both are composed into the task spec rather than kept beside it, so they are durable in the task
 * row, visible in every surface that shows a task, and unavoidable in the prompt.
 */

export const EXPECTED_HEADING = "## Expected return";
export const REQUEST_HEADING = "## Request";

/** Refuse a launch that does not say what it wants back, naming what to add. */
export function requireExpects(expects: string | undefined, what: string): string {
  const value = expects?.trim();
  if (!value) {
    throw new Error(
      `${what} needs \`expects\` (OR-10): what comes back — the artefact, its shape, and how ` +
        `anyone decides it was met. A phase title is not a task.`,
    );
  }
  return value;
}

export function requireRequest(request: string | undefined, what: string): string {
  const value = request?.trim();
  if (!value) {
    throw new Error(
      `${what} needs the request for this run (OR-10): what you are asking for, in your words. ` +
        `The project brief is the standing context; this is what changes from launch to launch.`,
    );
  }
  return value;
}

/**
 * The spec an agent receives: what was asked, then what is expected back. Idempotent — a spec that
 * already carries the heading is not given a second one, which matters when a task is requeued.
 */
export function composeSpec(input: { spec: string; expects: string }): string {
  const body = input.spec.trim();
  if (body.includes(EXPECTED_HEADING)) return body;
  return `${body}\n\n${EXPECTED_HEADING}\n\n${input.expects.trim()}`;
}
