/**
 * KB-12: a base may declare itself standing context, and an id is derived rather than asked for.
 */
import { describe, expect, it } from "vitest";
import { knowledgeManifestSchema } from "../src/knowledge/schema.js";
import { knowledgeAttachments } from "../src/projects/scaffold.js";
import { slugify } from "../src/ids.js";

const HOUSE = { id: "house-rules", default_attach: true };
const PLAIN = { id: "plain" };
const ids = (a: { baseId: string; writable: boolean }[]) => a.map((x) => x.baseId).sort();

describe("a base that attaches itself to every new project (KB-12)", () => {
  it("comes along without being asked for", () => {
    expect(ids(knowledgeAttachments({}, [HOUSE, PLAIN]))).toEqual(["house-rules"]);
  });

  it("is added to what the caller asked for, never instead of it", () => {
    const attached = knowledgeAttachments({ knowledge: ["plain"] }, [HOUSE, PLAIN]);
    expect(ids(attached)).toEqual(["house-rules", "plain"]);
  });

  it("does not quietly downgrade a base the caller wanted writable", () => {
    // The dangerous shape: `curated` is both default-attach and the writable one. Attaching it
    // twice, once read-only, would decide by row order what the project may do.
    const attached = knowledgeAttachments({ writableKnowledge: "curated" }, [
      { id: "curated", default_attach: true },
    ]);
    expect(attached).toEqual([{ baseId: "curated", writable: true }]);
  });

  it("does not attach the same base twice when it was named explicitly", () => {
    const attached = knowledgeAttachments({ knowledge: ["house-rules"] }, [HOUSE]);
    expect(attached).toEqual([{ baseId: "house-rules", writable: false }]);
  });

  it("attaches nothing when no base asked for it", () => {
    expect(knowledgeAttachments({}, [PLAIN])).toEqual([]);
  });

  it("is off unless a manifest says otherwise, and survives a round trip", () => {
    const base = { id: "x", name: "X", kind: "technical" };
    expect(knowledgeManifestSchema.parse(base).default_attach).toBe(false);
    expect(knowledgeManifestSchema.parse({ ...base, default_attach: true }).default_attach).toBe(
      true,
    );
  });
});

describe("an id derived from a name (KB-12)", () => {
  it("is the slug of the name", () => {
    expect(slugify("Core Platform")).toBe("core-platform");
    expect(slugify("API EFEMIS — técnico")).toBe("api-efemis-tecnico");
    expect(slugify("  Spaces   everywhere  ")).toBe("spaces-everywhere");
  });

  it("refuses a name that produces nothing, rather than inventing an id", () => {
    expect(() => slugify("!!!")).toThrow();
  });
});
