/**
 * LIGHTSOUT_RESULT sentinel (DESIGN §6.4).
 * The agent ends its final message with a fenced JSON block. A missing or invalid sentinel
 * on a clean turn is not a failure: the run is `ok` with the last message as summary plus a
 * `system` warning event, because agents occasionally forget.
 */
import { z } from "zod";

export const SENTINEL_OPEN = "<<<LIGHTSOUT_RESULT";
export const SENTINEL_CLOSE = ">>>";

export const doubtPayloadSchema = z
  .object({
    context: z.string().min(1),
    blocks: z.string().min(1),
    options: z
      .array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict())
      .min(2),
    recommendation: z.string().min(1).optional(),
    /**
     * `<base>/<document>` of the binding rule the agent would have to break (KB-11b). Its presence
     * is what makes this a `hard_rule` doubt: no advisor, no auto-continue, a human or nothing.
     */
    hardRule: z.string().min(1).optional(),
  })
  .strict();

export const resultSchema = z
  .object({
    status: z.enum(["ok", "doubt"]),
    summary: z.string().default(""),
    doubt: doubtPayloadSchema.optional(),
  })
  .strict()
  .refine((r) => r.status !== "doubt" || r.doubt !== undefined, {
    message: "status 'doubt' requires a doubt payload",
  });

export type AgentResult = z.infer<typeof resultSchema>;
export type DoubtPayload = z.infer<typeof doubtPayloadSchema>;

export type ParsedResult =
  | { ok: true; result: AgentResult }
  | { ok: false; error: string; fallbackSummary: string };

/** Excerpt used as summary when the sentinel is missing. */
function excerpt(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Extract and validate the sentinel from the agent's final message.
 * Uses the last occurrence: agents sometimes echo the format earlier in the turn.
 */
export function parseResult(finalMessage: string): ParsedResult {
  const open = finalMessage.lastIndexOf(SENTINEL_OPEN);
  if (open === -1) {
    return {
      ok: false,
      error: "no LIGHTSOUT_RESULT sentinel in the final message",
      fallbackSummary: excerpt(finalMessage),
    };
  }
  const afterOpen = finalMessage.slice(open + SENTINEL_OPEN.length);
  const close = afterOpen.indexOf(SENTINEL_CLOSE);
  const body = close === -1 ? afterOpen : afterOpen.slice(0, close);

  let json: unknown;
  try {
    json = JSON.parse(body.trim());
  } catch (err) {
    return {
      ok: false,
      error: `sentinel is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      fallbackSummary: excerpt(finalMessage.slice(0, open)),
    };
  }

  const parsed = resultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `sentinel failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      fallbackSummary: excerpt(finalMessage.slice(0, open)),
    };
  }

  const result = parsed.data;
  if (!result.summary.trim()) {
    result.summary = excerpt(finalMessage.slice(0, open));
  }
  return { ok: true, result };
}
