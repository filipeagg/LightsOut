/**
 * The engine and model a launch chooses (AP-09, OR-11, DESIGN §5.5).
 *
 * Two things are being protected here. That the merge is exactly "the launch's choice, else the
 * profile's" and nothing cleverer — an override that half-applied would run the wrong model and
 * record the right one. And that a bad choice is refused with the accepted values in the sentence,
 * because a refusal that does not say what was expected is a second round trip.
 */
import { describe, expect, it } from "vitest";
import {
  isOverridden,
  modelCatalog,
  resolveProfile,
  validateModelChoice,
} from "../src/agents/effective.js";
import type { AgentProfile } from "../src/agents/schema.js";

const builder: AgentProfile = {
  id: "builder",
  name: "Builder",
  engine: "claude",
  model: "sonnet",
  reasoning: "medium",
  instructions: "",
  include: [],
  policy: "default",
  tags: [],
  advisor: false,
  enabled: true,
};

describe("resolveProfile (AP-09)", () => {
  it("returns the profile itself when the launch chose nothing", () => {
    expect(resolveProfile(builder, undefined)).toBe(builder);
    expect(resolveProfile(builder, { engine: null, model: null, reasoning: null })).toBe(builder);
  });

  it("takes the launch's model and leaves everything else alone", () => {
    const resolved = resolveProfile(builder, { model: "haiku" });
    expect(resolved.model).toBe("haiku");
    expect(resolved.engine).toBe("claude");
    expect(resolved.reasoning).toBe("medium");
    expect(resolved.policy).toBe("default");
    expect(resolved.instructions).toBe(builder.instructions);
  });

  it("drops the profile's model when the engine changes, because it means nothing there", () => {
    const resolved = resolveProfile(builder, { engine: "codex" });
    expect(resolved.engine).toBe("codex");
    expect(resolved.model).toBeUndefined();
  });

  it("keeps an explicit model when the engine changes with it", () => {
    const resolved = resolveProfile(builder, { engine: "codex", model: "gpt-5-codex" });
    expect(resolved).toMatchObject({ engine: "codex", model: "gpt-5-codex" });
  });

  it("never writes back to the profile it was given (AP-01)", () => {
    resolveProfile(builder, { engine: "codex", model: "gpt-5" });
    expect(builder).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  it("reports an override only when something actually changed", () => {
    expect(isOverridden(builder, { model: "sonnet" })).toBe(false);
    expect(isOverridden(builder, undefined)).toBe(false);
    expect(isOverridden(builder, { model: "opus" })).toBe(true);
    expect(isOverridden(builder, { reasoning: "high" })).toBe(true);
  });
});

describe("validateModelChoice (OR-11)", () => {
  it("accepts nothing, and accepts a known combination", () => {
    expect(validateModelChoice(builder, undefined)).toBeNull();
    expect(validateModelChoice(builder, { model: "opus", reasoning: "high" })).toBeNull();
    expect(validateModelChoice(builder, { engine: "codex", model: "gpt-5-codex" })).toBeNull();
  });

  it("refuses an unknown engine, listing the ones there are", () => {
    const problem = validateModelChoice(builder, { engine: "gemini" });
    expect(problem).toContain("gemini");
    expect(problem).toContain("claude");
    expect(problem).toContain("codex");
  });

  it("refuses a model the engine does not have, listing the ones it does", () => {
    const problem = validateModelChoice(builder, { model: "gpt-5" });
    expect(problem).toContain("gpt-5");
    expect(problem).toContain("sonnet");
    // The engine was assumed from the profile; say so, or the caller cannot tell why.
    expect(problem).toContain("assumed");
  });

  it("checks the model against the engine the launch chose, not the profile's", () => {
    expect(validateModelChoice(builder, { engine: "codex", model: "gpt-5" })).toBeNull();
    expect(validateModelChoice(builder, { engine: "codex", model: "sonnet" })).toContain(
      "codex does not accept",
    );
  });

  it("refuses an unknown reasoning level", () => {
    const problem = validateModelChoice(builder, { reasoning: "extreme" });
    expect(problem).toContain("extreme");
    expect(problem).toContain("minimal");
  });
});

describe("modelCatalog (AP-09 discovery)", () => {
  it("publishes both engines with a non-empty model list", () => {
    const catalog = modelCatalog();
    expect(catalog.map((e) => e.engine).sort()).toEqual(["claude", "codex"]);
    for (const entry of catalog) {
      expect(entry.models.length).toBeGreaterThan(0);
      expect(entry.reasoning).toContain("low");
    }
  });
});
