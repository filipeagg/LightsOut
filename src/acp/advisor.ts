/**
 * Ephemeral advisory sessions (SR-08, DO-02, DESIGN §8.2).
 *
 * The advisor is the OTHER engine, in a throwaway session with a read-only policy pack, asked
 * to answer with JSON only. It never edits anything: its verdict feeds the auto-continue rule.
 * Anything that goes wrong — timeout, crash, unparseable answer — is reported as a failure so
 * the caller can fail toward the human rather than toward silence.
 */
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import { spawnAdapter } from "./adapter.js";
import type { Engine } from "../db/types.js";

export const advisorAnswerSchema = z
  .object({
    choice: z.string().min(1),
    confidence: z.coerce.number().min(0).max(1),
    rationale: z.string().default(""),
  })
  .strict();

export type AdvisorAnswer = z.infer<typeof advisorAnswerSchema>;

export type AdvisorResult =
  | { ok: true; engine: Engine; answer: AdvisorAnswer; durationMs: number }
  | { ok: false; engine: Engine; error: string; durationMs: number };

export type ConsultInput = {
  engine: Engine;
  adapterCommand: string;
  cwd: string;
  /** The question, already including whatever context the advisor needs. */
  question: string;
  options: { id: string; text: string }[];
  /** Hard limit; the design says 60 s (DESIGN §8.2). */
  timeoutMs?: number;
  onStderr?: (line: string) => void;
};

export const ADVISOR_TIMEOUT_MS = 60_000;

/** The other engine, so a second opinion is never the same model agreeing with itself. */
export function otherEngine(engine: Engine): Engine {
  return engine === "claude" ? "codex" : "claude";
}

function buildPrompt(input: ConsultInput): string {
  const options = input.options.map((o) => `${o.id}) ${o.text}`).join("\n");
  return [
    "You are giving a second opinion on a decision taken by another coding agent.",
    "You have read-only access to the repository in the current directory. Do not modify anything.",
    "",
    "## Question",
    input.question,
    "",
    "## Options",
    options,
    "",
    "Answer with ONE line of JSON and nothing else, no prose, no code fence:",
    '{"choice":"<option id>","confidence":<0..1>,"rationale":"<80 words max>"}',
  ].join("\n");
}

/** Pull the JSON object out of a reply that may still carry prose or a code fence. */
export function parseAdvisorAnswer(text: string): AdvisorAnswer | undefined {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = advisorAnswerSchema.safeParse(JSON.parse(candidate.trim()));
      if (parsed.success) return parsed.data;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function consultAdvisor(input: ConsultInput): Promise<AdvisorResult> {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? ADVISOR_TIMEOUT_MS;
  const adapter = spawnAdapter({
    command: input.adapterCommand,
    cwd: input.cwd,
    ...(input.onStderr ? { onStderr: input.onStderr } : {}),
  });

  const fail = (error: string): AdvisorResult => ({
    ok: false,
    engine: input.engine,
    error,
    durationMs: Date.now() - startedAt,
  });

  try {
    // The connection rejects with "ACP connection closed" once the adapter is stopped, which
    // can happen after we already have the answer or after the timeout won the race. Keeping
    // the handler attached means that late rejection is never unhandled.
    let settled = false;
    const conversation = acp
      .client({ name: "lightsout-advisor" })
        // Read-only by construction: every permission request is rejected.
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          const reject = ctx.params.options.find(
            (o) => o.kind === "reject_once" || o.kind === "reject_always",
          );
          return reject
            ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
            : { outcome: { outcome: "cancelled" as const } };
        })
        .connectWith(adapter.stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          return ctx.buildSession(input.cwd).withSession(async (session) => {
            let text = "";
            void session.prompt(buildPrompt(input)).catch(() => undefined);
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return text;
              const update = message.notification.update;
              if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text"
              ) {
                text += update.content.text;
              }
            }
          });
      })
      .catch((err: unknown) => {
        if (settled) return ""; // late failure after we already had the answer
        throw err;
      });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`advisor timeout after ${timeoutMs} ms`)), timeoutMs),
    );

    let reply: string;
    try {
      reply = await Promise.race([conversation, timeout]);
    } finally {
      settled = true;
    }

    const answer = parseAdvisorAnswer(reply);
    if (!answer) return fail(`advisor reply was not usable JSON: ${reply.slice(0, 200)}`);
    if (!input.options.some((o) => o.id === answer.choice)) {
      return fail(`advisor chose an option that does not exist: ${answer.choice}`);
    }
    return { ok: true, engine: input.engine, answer, durationMs: Date.now() - startedAt };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  } finally {
    await adapter.stop(5000);
  }
}
