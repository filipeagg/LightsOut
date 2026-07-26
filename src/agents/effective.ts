/**
 * The engine and model a run actually uses (AP-09, DESIGN §5.5).
 *
 * A profile fixes a default, not an unchangeable property. A launch may override the engine, the
 * model and the reasoning level for that launch alone, and this module is the single place the two
 * are merged: the runner calls `resolveProfile` once and everything downstream — the adapter
 * command, the `runs` row, the prompt, the session — reads the result. Nothing else reads
 * `profile.model` directly, so the profile and the run cannot disagree about which model did the
 * work.
 *
 * Validation lives here too, because a launch is refused before a task row exists (OR-11): the
 * rejection names what was expected, which is the whole difference between a refusal and a
 * mystery.
 */
import type { AgentProfile } from "./schema.js";
import {
  ENGINE_IDS,
  ENGINE_MODELS,
  REASONING_LEVELS,
  isKnownModel,
  modelRejection,
  type EngineId,
} from "./models.js";

/** What a launch may say about the engine and the model. Every field is optional. */
export type ModelChoice = {
  engine?: string | null;
  model?: string | null;
  reasoning?: string | null;
};

/** Just enough of a task row to resolve one; the runner passes the row itself. */
export type ModelOverrideSource = ModelChoice;

/**
 * The profile as this run will use it. Field by field: what the launch chose, else what the
 * profile says. An override of the engine alone is legitimate — the same instructions on the other
 * engine — and drops the profile's model, because a Claude model name means nothing to Codex.
 */
export function resolveProfile(
  profile: AgentProfile,
  override: ModelOverrideSource | null | undefined,
): AgentProfile {
  if (!override) return profile;
  const engine = (override.engine as EngineId | undefined) ?? profile.engine;
  const engineChanged = engine !== profile.engine;
  const model = override.model ?? (engineChanged ? undefined : profile.model);
  const reasoning =
    (override.reasoning as AgentProfile["reasoning"] | undefined) ?? profile.reasoning;
  if (engine === profile.engine && model === profile.model && reasoning === profile.reasoning) {
    return profile;
  }
  return {
    ...profile,
    engine,
    ...(model ? { model } : { model: undefined }),
    ...(reasoning ? { reasoning } : { reasoning: undefined }),
  };
}

/** Did this launch actually change anything? Used to decide whether the audit has news. */
export function isOverridden(
  profile: AgentProfile,
  override: ModelOverrideSource | null | undefined,
): boolean {
  const resolved = resolveProfile(profile, override);
  return (
    resolved.engine !== profile.engine ||
    resolved.model !== profile.model ||
    resolved.reasoning !== profile.reasoning
  );
}

/**
 * Check a launch's choice against the catalog before a task exists (OR-11). Returns the reason it
 * is refused, or null when it is fine. Every message names the accepted values: a rejection that
 * does not say what was expected costs the caller another round trip.
 */
export function validateModelChoice(
  profile: AgentProfile,
  choice: ModelChoice | null | undefined,
): string | null {
  if (!choice) return null;
  const { engine, model, reasoning } = choice;

  if (engine != null && !ENGINE_IDS.includes(engine as EngineId)) {
    return `unknown engine "${engine}"; choose one of: ${ENGINE_IDS.join(", ")}`;
  }
  const resolvedEngine = (engine as EngineId | undefined) ?? profile.engine;

  if (model != null) {
    if (!isKnownModel(resolvedEngine, model)) {
      const assumed =
        engine == null
          ? ` (no engine given, so the profile's engine "${profile.engine}" was assumed; pass engine to change it)`
          : "";
      return `${modelRejection(resolvedEngine, model)}${assumed}`;
    }
  }

  if (reasoning != null && !REASONING_LEVELS.includes(reasoning as (typeof REASONING_LEVELS)[number])) {
    return `unknown reasoning level "${reasoning}"; choose one of: ${REASONING_LEVELS.join(", ")}`;
  }

  return null;
}

/** The catalog, in the shape `list_agents` and the panel serve it (AP-08, AP-09). */
export function modelCatalog(): { engine: EngineId; models: string[]; reasoning: string[] }[] {
  return ENGINE_IDS.map((engine) => ({
    engine,
    models: [...ENGINE_MODELS[engine].models],
    reasoning: [...ENGINE_MODELS[engine].reasoning],
  }));
}
