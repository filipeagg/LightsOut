/**
 * Accepted model and reasoning values per engine (AP-08).
 *
 * One table, read by the panel through `GET /api/agents/models` and by the write routes that
 * validate a profile before it is saved, so the list the user picks from and the list the server
 * accepts cannot drift. The panel offers a select and never a free-text box: an unknown model is
 * a rejection with a reason here, not a failure at launch time (AP-08).
 *
 * Both CLIs take either an alias for the current model of a family or a full model name — this is
 * `claude --model` verbatim: "Provide an alias for the latest model (e.g. 'fable', 'opus', or
 * 'sonnet') or a model's full name (e.g. 'claude-fable-5')". Aliases are listed first because
 * they keep working when a family is refreshed; full names are listed for the runs that must stay
 * reproducible. There is no endpoint on either engine that publishes this, so the table is static
 * and reviewed by hand when an engine ships a model.
 */

/** The reasoning levels the profile schema accepts (`agentProfileSchema.reasoning`). */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;

export type EngineId = "claude" | "codex";

export type EngineModels = {
  /** Offered in this order; the first entry is what a new profile starts on. */
  models: readonly string[];
  reasoning: readonly string[];
};

export const ENGINE_MODELS: Record<EngineId, EngineModels> = {
  claude: {
    models: [
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "claude-sonnet-4-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-fable-5",
    ],
    reasoning: REASONING_LEVELS,
  },
  codex: {
    models: ["gpt-5-codex", "gpt-5", "o4-mini", "o3"],
    reasoning: REASONING_LEVELS,
  },
};

export const ENGINE_IDS = Object.keys(ENGINE_MODELS) as EngineId[];

/** The default model for an engine: what the editor selects when nothing is set yet. */
export function defaultModel(engine: EngineId): string {
  return ENGINE_MODELS[engine].models[0]!;
}

/**
 * Is this model offered for this engine? A profile carrying something else is not rewritten —
 * the workspace file stays the source of truth (AP-01) — but the panel shows it as its own
 * option so saving cannot silently swap the model out from under a running installation.
 */
export function isKnownModel(engine: EngineId, model: string): boolean {
  return ENGINE_MODELS[engine].models.includes(model);
}

/** The message AP-08 asks for: a rejection that says what was expected. */
export function modelRejection(engine: EngineId, model: string): string {
  return `${engine} does not accept model "${model}"; choose one of: ${ENGINE_MODELS[engine].models.join(", ")}`;
}
