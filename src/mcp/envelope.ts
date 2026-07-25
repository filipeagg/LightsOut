/**
 * Uniform tool envelope (DESIGN §10.2).
 * Success is `{ok:true, …}`; failure is `{ok:false, error:{code,message}}`. Tools never throw
 * at the protocol level: an error is data, so Claude Desktop can explain it in plain language.
 */
export const ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_INPUT",
  "PROJECT_LOCKED",
  "AUTH_REQUIRED",
  "CONFLICT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type Envelope = { ok: true; [key: string]: unknown } | {
  ok: false;
  error: { code: ErrorCode; message: string };
};

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const notFound = (what: string) => new ToolError("NOT_FOUND", what);
export const invalid = (why: string) => new ToolError("INVALID_INPUT", why);
export const conflict = (why: string) => new ToolError("CONFLICT", why);

export function success(payload: Record<string, unknown>): Envelope {
  return { ok: true, ...payload };
}

export function failure(err: unknown): Envelope {
  if (err instanceof ToolError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  // A missing row surfaces as a repo error; keep the code useful instead of always INTERNAL.
  const code: ErrorCode = /not found/i.test(message) ? "NOT_FOUND" : "INTERNAL";
  return { ok: false, error: { code, message } };
}

/** MCP tool result carrying the envelope as JSON text (MC-03: compact structured JSON). */
export function toolResult(envelope: Envelope): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = JSON.stringify(envelope, null, 2);
  return envelope.ok ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true };
}
