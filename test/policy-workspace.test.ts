/**
 * Phase 9 additions to the policy engine: workspace-aware classification (§7.1),
 * pack write scopes (BA-05) and the prompt blocks knowledge and the vault produce.
 */
import { describe, expect, it } from "vitest";
import { Classifier } from "../src/policy/classify.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { policyPackSchema, type PolicyPack } from "../src/policy/schema.js";
import { composePrompt } from "../src/acp/prompt.js";

const WORKSPACE = "/workspace";
const PROJECT = "/workspace/projects/demo";

function pack(id: string, extra: Partial<PolicyPack> = {}) {
  return policyPackSchema.parse({
    id,
    rules: [
      { class: "project_read", verdict: "allow" },
      { class: "project_write", verdict: "allow" },
      { class: "knowledge_write", verdict: "deny" },
      { class: "outside_workspace", verdict: "deny" },
      { class: "credentials", verdict: "require_human" },
      { class: "delete", verdict: "require_human" },
      { class: "other", verdict: "require_human" },
    ],
    ...extra,
  });
}

describe("workspace-aware classification (§7.1)", () => {
  const classifier = new Classifier();
  const classify = (
    input: Partial<Parameters<Classifier["classify"]>[0]>,
  ): string =>
    classifier.classify({
      projectPath: PROJECT,
      workspacePath: WORKSPACE,
      ...input,
    }).class;

  it("treats reading a knowledge base as a read, not an escape", () => {
    expect(
      classify({ kind: "read", paths: ["/workspace/knowledge/erp/data-model.md"] }),
    ).toBe("project_read");
  });

  it("allows a write only into the base the project owns (KB-05)", () => {
    expect(
      classify({
        kind: "edit",
        paths: ["/workspace/knowledge/erp/index.md"],
        writableKnowledgeBase: "erp",
      }),
    ).toBe("knowledge_write");

    expect(
      classify({
        kind: "edit",
        paths: ["/workspace/knowledge/other/index.md"],
        writableKnowledgeBase: "erp",
      }),
    ).toBe("outside_workspace");

    // No writable base at all: writing anywhere in knowledge/ is outside_workspace.
    expect(classify({ kind: "edit", paths: ["/workspace/knowledge/erp/index.md"] })).toBe(
      "outside_workspace",
    );
  });

  /**
   * KB-05 amended (§17.1b): a base may read its documents from a subfolder of knowledge/, and
   * `knowledge/<id>` is only the default location. Deriving the directory from the id made such a
   * base attachable as writable and then denied every write to it — attachable and unusable.
   */
  it("allows the write when the base's documents live deeper inside knowledge/ (§17.1b)", () => {
    expect(
      classify({
        kind: "edit",
        paths: ["/workspace/knowledge/hispatec/mercado/index.md"],
        writableKnowledgeBase: "mercado",
        writableKnowledgeDir: "/workspace/knowledge/hispatec/mercado",
      }),
    ).toBe("knowledge_write");

    // Still only that folder: a sibling under the same parent is somebody else's base.
    expect(
      classify({
        kind: "edit",
        paths: ["/workspace/knowledge/hispatec/tecnico/index.md"],
        writableKnowledgeBase: "mercado",
        writableKnowledgeDir: "/workspace/knowledge/hispatec/mercado",
      }),
    ).toBe("outside_workspace");
  });

  it("classifies the system's own configuration as credentials, whatever the pack says", () => {
    expect(classify({ kind: "edit", paths: ["/workspace/agents/builder.yaml"] })).toBe(
      "credentials",
    );
    expect(classify({ kind: "edit", paths: ["/workspace/templates/mine.yaml"] })).toBe(
      "credentials",
    );
    expect(classify({ kind: "read", paths: ["/workspace/vault.yaml"] })).toBe("credentials");
  });

  it("keeps the phase 3 reading when no workspace is given", () => {
    const bare = new Classifier().classify({
      projectPath: PROJECT,
      kind: "read",
      paths: ["/workspace/knowledge/erp/a.md"],
    });
    expect(bare.class).toBe("outside_workspace");
  });
});

describe("write scopes (BA-05)", () => {
  const confined = new PolicyEngine({
    agent: pack("read-only", { write_scopes: ["doc"] }),
    default: pack("default"),
  });

  it("allows a write inside the scope and denies one outside it", () => {
    expect(
      confined.evaluate({ projectPath: PROJECT, kind: "edit", paths: ["doc/PLAN.md"] })
        .verdict,
    ).toBe("allow");

    const outside = confined.evaluate({
      projectPath: PROJECT,
      kind: "edit",
      paths: ["src/index.ts"],
    });
    expect(outside.verdict).toBe("deny");
    expect(outside.reason).toMatch(/outside this pack's scopes/);
  });

  it("denies a write whose target it cannot see", () => {
    expect(confined.evaluate({ projectPath: PROJECT, kind: "edit" }).verdict).toBe("deny");
  });

  it("leaves writes unconfined when no pack declares scopes", () => {
    const open = new PolicyEngine({ agent: pack("default"), default: pack("default") });
    expect(
      open.evaluate({ projectPath: PROJECT, kind: "edit", paths: ["src/index.ts"] }).verdict,
    ).toBe("allow");
  });
});

describe("prompt blocks", () => {
  const base = {
    instructions: "be careful",
    projectPath: PROJECT,
    taskTitle: "Probe it",
    taskSpec: "call the API",
  };

  it("carries knowledge and the vault index when they exist", () => {
    const prompt = composePrompt(
      {
        ...base,
        knowledgeBase: "--- knowledge: erp (technical) — index.md ---",
        vaultIndex: "- sandbox — Sandbox\n  token: $LO_VAULT_SANDBOX_TOKEN",
      },
      {},
    );
    expect(prompt).toContain("# Knowledge base");
    expect(prompt).toContain("# Credentials");
    expect(prompt).toContain("$LO_VAULT_SANDBOX_TOKEN");
  });

  it("omits both blocks when there is nothing to say", () => {
    const prompt = composePrompt(base, {});
    expect(prompt).not.toContain("# Knowledge base");
    expect(prompt).not.toContain("# Credentials");
  });
});
