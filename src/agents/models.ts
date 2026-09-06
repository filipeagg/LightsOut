/**
 * What each engine accepts as a model and a reasoning level (AP-08, DESIGN §5.6).
 *
 * The engine is the source. `catalog.ts` asks the adapter — `session/new` answers with a select of
 * category `model` and one of category `thought_level` — and publishes the answer here, where the
 * validators the panel, the write routes and the launch check all share can see it. This module
 * holds two things: that published catalog, and the fallback used when an engine cannot be asked.
 *
 * The fallback is not a promise. It was a hand-written table once, and measuring it against the
 * real adapters showed it offering `opus`, `claude-opus-5`, `gpt-5-codex` and `o4-mini` when the
 * adapters offered none of them — nobody noticed because the model never reached the engine at all
 * (§6.1). It exists so a panel with an unauthenticated engine still shows something, and it says
 * so: `catalogSource(engine)` returns "fallback" and the panel is expected to mark it.
 *
 * Reasoning levels are per engine. A single global list was a third piece of fiction: it offered
 * `minimal`, which neither engine accepts, and withheld `xhigh`, `max` and `ultra`, which they do.
 */

export type EngineId = "claude" | "codex";

/**
 * Every level any engine has been seen to accept, for the *shape* check in the profile schema.
 * Whether a given engine accepts a given level is `isKnownReasoning`, not this.
 */
export const ALL_REASONING_LEVELS = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningLevel = (typeof ALL_REASONING_LEVELS)[number];

export type EngineModels = {
  /** Offered in this order; the first entry is what a new profile starts on. */
  models: readonly string[];
  reasoning: readonly string[];
};

/**
 * What to answer when the engine cannot be asked. Deliberately short: a longer list is not a
 * better guess, and every entry here is one the panel may offer and the engine may then refuse.
 */
export const FALLBACK_MODELS: Record<EngineId, EngineModels> = {
  claude: {
    models: ["default", "sonnet", "haiku"],
    reasoning: ["default", "low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    reasoning: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
};

export const ENGINE_IDS = Object.keys(FALLBACK_MODELS) as EngineId[];

/** What an engine told us about itself, once `catalog.ts` has asked it. */
export type PublishedCatalog = EngineModels & {
  /** The engine's own current selection, which is what a profile naming nothing will run on. */
  currentModel: string | null;
  currentReasoning: string | null;
};

const published = new Map<EngineId, PublishedCatalog>();

/** Called by `catalog.ts` when an engine has answered. */
export function publishCatalog(engine: EngineId, catalog: PublishedCatalog): void {
  published.set(engine, catalog);
}

/** Called when an engine's credentials failed, or in tests: what it said is no longer trusted. */
export function unpublishCatalog(engine?: EngineId): void {
  if (engine) published.delete(engine);
  else published.clear();
}

/** Did this list come from the engine, or are we guessing? The panel says which. */
export function catalogSource(engine: EngineId): "engine" | "fallback" {
  return published.has(engine) ? "engine" : "fallback";
}

/** The accepted values for an engine: what it told us, else the fallback. */
export function engineModels(engine: EngineId): EngineModels {
  return published.get(engine) ?? FALLBACK_MODELS[engine];
}

/** The engine's own current model, when it has told us; otherwise null. */
export function currentModel(engine: EngineId): string | null {
  return published.get(engine)?.currentModel ?? null;
}

/**
 * The default model for an engine: what the editor selects when nothing is set yet. The engine's
 * own current selection when it has one, because that is what a profile naming nothing will run
 * on, and a default that disagrees with the engine is how the two drift apart again.
 */
export function defaultModel(engine: EngineId): string {
  return currentModel(engine) ?? engineModels(engine).models[0]!;
}

/**
 * Is this model offered for this engine? A profile carrying something else is not rewritten —
 * the workspace file stays the source of truth (AP-01) — but it is reported invalid and refused
 * at launch, so nothing silently runs on a model nobody chose.
 */
export function isKnownModel(engine: EngineId, model: string): boolean {
  return engineModels(engine).models.includes(model);
}

export function isKnownReasoning(engine: EngineId, reasoning: string): boolean {
  return engineModels(engine).reasoning.includes(reasoning);
}

/** The message AP-08 asks for: a rejection that says what was expected. */
export function modelRejection(engine: EngineId, model: string): string {
  const { models } = engineModels(engine);
  const caveat =
    catalogSource(engine) === "fallback"
      ? " (the engine could not be asked, so this is the fallback list)"
      : "";
  return `${engine} does not accept model "${model}"; choose one of: ${models.join(", ")}${caveat}`;
}

export function reasoningRejection(engine: EngineId, reasoning: string): string {
  const levels = engineModels(engine).reasoning;
  return `${engine} does not accept reasoning "${reasoning}"; choose one of: ${levels.join(", ")}`;
}
