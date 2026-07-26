/** Phase 9: template loading (TP-01/03), knowledge injection (KB-04/06) and the vault (VT-*). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TemplatesLoader } from "../src/templates/loader.js";
import { KnowledgeLoader } from "../src/knowledge/loader.js";
import { buildKnowledgeBlock } from "../src/knowledge/inject.js";
import { Vault, renderVaultIndex } from "../src/vault/vault.js";
import { envVarName } from "../src/vault/schema.js";

let workspace: string;
const everyAgent = () => true;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lo-p9-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const writeTemplate = async (name: string, body: string) => {
  await mkdir(path.join(workspace, "templates"), { recursive: true });
  await writeFile(path.join(workspace, "templates", name), body, "utf8");
};

describe("templates loader", () => {
  it("loads the four builtin templates (TP-02)", async () => {
    const loader = new TemplatesLoader(workspace, everyAgent);
    const report = await loader.load();
    expect(report.loaded).toBe(4);
    expect(report.rejected).toEqual([]);
    expect(loader.list().map((t) => t.id)).toEqual([
      "full-development",
      "knowledge-curation",
      "quick-answers",
      "quick-prototype",
    ]);
    const full = loader.getOrThrow("full-development");
    expect(full.phases.map((p) => p.id)).toEqual([
      "shape-the-prompt",
      "probe-contracts",
      "plan",
      "build",
      "qa",
      "audit",
    ]);
    expect(full.phases[0]?.gate).toBe("human");
    expect(full.phases[1]?.optional).toBe(true);
    expect(full.phases[3]?.verify).toBe("npm test");
  });

  it("rejects a template whose agent does not resolve (TP-03, AP-07)", async () => {
    await writeTemplate(
      "ghosted.yaml",
      "name: Ghosted\nphases:\n  - { id: one, title: One, agent: ghost, instructions: do it }\n",
    );
    const loader = new TemplatesLoader(workspace, (id) => id !== "ghost");
    const report = await loader.load();
    expect(report.rejected.map((r) => r.id)).toEqual(["ghosted"]);
    expect(report.rejected[0]?.error).toMatch(/ghost/);
    expect(loader.get("ghosted")).toBeUndefined();
    expect(() => loader.getOrThrow("ghosted")).toThrow(/not usable/);
  });

  it("rejects a workspace: deliverable without a writable knowledge base (§16.3)", async () => {
    await writeTemplate(
      "curate.yaml",
      [
        "name: Curate",
        "phases:",
        "  - id: write",
        "    title: Write",
        "    agent: codebase-analyst",
        "    instructions: write it",
        '    deliverable: "workspace:knowledge/base/index.md"',
        "",
      ].join("\n"),
    );
    const loader = new TemplatesLoader(workspace, everyAgent);
    const report = await loader.load();
    expect(report.rejected[0]?.error).toMatch(/writable knowledge base/);
  });

  it("lets a workspace template shadow a builtin by id (§2)", async () => {
    await writeTemplate(
      "quick-answers.yaml",
      "name: Mine\nphases:\n  - { id: ask, title: Ask, agent: answerer, instructions: answer }\n",
    );
    const loader = new TemplatesLoader(workspace, everyAgent);
    const report = await loader.load();
    expect(report.loaded).toBe(4);
    expect(report.fromWorkspace).toBe(1);
    expect(loader.getOrThrow("quick-answers").name).toBe("Mine");
  });
});

async function seedBase(
  id: string,
  manifest: string,
  docs: Record<string, string>,
): Promise<void> {
  const dir = path.join(workspace, "knowledge", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "knowledge.yaml"), manifest, "utf8");
  for (const [file, body] of Object.entries(docs)) {
    await writeFile(path.join(dir, file), body, "utf8");
  }
}

describe("knowledge loader and injection", () => {
  it("reads a manifest, its index and its documents (KB-01)", async () => {
    await seedBase(
      "legacy-core",
      "name: Legacy core\nkind: technical\ntags: [core, legacy]\nupdated: 2026-07-01\n",
      { "index.md": "- data-model.md: the tables", "data-model.md": "TABLES" },
    );
    const loader = new KnowledgeLoader(workspace);
    const report = await loader.load();
    expect(report.loaded).toBe(1);
    const base = loader.getOrThrow("legacy-core");
    expect(base.manifest.kind).toBe("technical");
    expect(base.manifest.updated).toBe("2026-07-01");
    expect(base.index).toContain("data-model.md");
    expect(base.documents.map((d) => d.file)).toEqual(["data-model.md"]);
  });

  it("rejects a base whose manifest id is not the directory name", async () => {
    await seedBase("mine", "id: theirs\nname: Theirs\nkind: other\n", {});
    const report = await new KnowledgeLoader(workspace).load();
    expect(report.loaded).toBe(0);
    expect(report.rejected[0]?.error).toMatch(/does not match the directory name/);
  });

  it("refuses to read a document outside the base", async () => {
    await seedBase("legacy-core", "name: E\nkind: technical\n", { "a.md": "A" });
    const loader = new KnowledgeLoader(workspace);
    await loader.load();
    await expect(loader.readDocument("legacy-core", "../../secret")).rejects.toThrow(/escapes/);
  });

  it("always injects manifests and index.md, and lists what the budget left out (KB-06)", async () => {
    await seedBase("legacy-core", "name: Legacy core\nkind: technical\ntags: [core]\n", {
      "index.md": "- big.md: everything",
      "big.md": "X".repeat(5000),
      "small.md": "SMALL FACT",
    });
    const loader = new KnowledgeLoader(workspace);
    await loader.load();

    const generous = await buildKnowledgeBlock(loader, ["legacy-core"], { budgetChars: 100000 });
    expect(generous.included.map((d) => d.file).sort()).toEqual(["big.md", "small.md"]);
    expect(generous.text).toContain("--- knowledge: legacy-core (technical) — small.md ---");
    expect(generous.omitted).toEqual([]);

    const tight = await buildKnowledgeBlock(loader, ["legacy-core"], { budgetChars: 1200 });
    expect(tight.included.map((d) => d.file)).toEqual(["small.md"]);
    expect(tight.omitted.map((d) => d.file)).toEqual(["big.md"]);
    expect(tight.text).toContain("index.md");
    expect(tight.text).toContain('read_knowledge("legacy-core", "big.md")');
  });

  it("returns nothing when no base is attached", async () => {
    const loader = new KnowledgeLoader(workspace);
    await loader.load();
    const block = await buildKnowledgeBlock(loader, [], { budgetChars: 1000 });
    expect(block.text).toBe("");
  });
});

describe("vault", () => {
  it("stores values, returns views without them, and merges on update (VT-02, VT-03)", async () => {
    const vault = new Vault(workspace);
    await vault.put("sandbox-api", {
      label: "Sandbox API",
      base_url: "https://sandbox.example.com",
      auth: "bearer",
      test_only: true,
      fields: { token: "s3cret", user: "probe" },
    });

    const views = await vault.listViews();
    expect(views).toHaveLength(1);
    expect(JSON.stringify(views)).not.toContain("s3cret");
    expect(views[0]?.fields.map((f) => f.name).sort()).toEqual(["token", "user"]);

    // An omitted field keeps its value; a null clears it.
    await vault.put("sandbox-api", { fields: { user: null } });
    const after = await vault.readAll();
    expect(after[0]?.fields).toEqual({ token: "s3cret" });
    expect(after[0]?.label).toBe("Sandbox API");
  });

  it("writes the file 600 and keeps it parseable", async () => {
    const vault = new Vault(workspace);
    await vault.put("one", { label: "One", fields: { key: "v" } });
    const text = await readFile(path.join(workspace, "vault.yaml"), "utf8");
    expect(text).toContain("entries:");
    expect(await vault.remove("one")).toBe(true);
    expect(await vault.listViews()).toEqual([]);
  });

  it("scopes entries to the project and enforces test_only (VT-06)", async () => {
    const vault = new Vault(workspace);
    await vault.put("prod", { label: "Prod", fields: { token: "p" } });
    await vault.put("sandbox", { label: "Sandbox", test_only: true, fields: { token: "s" } });
    await vault.put("other", { label: "Other", scope: ["another-project"], fields: { k: "v" } });

    const open = await vault.resolveForRun({ projectId: "demo", testOnlyRequired: false });
    expect(open.index.map((e) => e.id).sort()).toEqual(["prod", "sandbox"]);
    expect(open.env[envVarName("prod", "token")]).toBe("p");
    expect(open.reads.map((r) => r.entryId).sort()).toEqual(["prod", "sandbox"]);

    const probing = await vault.resolveForRun({ projectId: "demo", testOnlyRequired: true });
    expect(probing.index.map((e) => e.id)).toEqual(["sandbox"]);
    expect(probing.refused.map((r) => r.entryId)).toEqual(["prod"]);
    expect(probing.env[envVarName("prod", "token")]).toBeUndefined();
  });

  it("renders an index with variable names and never a value (VT-02)", async () => {
    const vault = new Vault(workspace);
    await vault.put("sandbox", {
      label: "Sandbox",
      test_only: true,
      notes: "60 rpm",
      fields: { token: "s3cret", empty: "" },
    });
    const resolved = await vault.resolveForRun({ projectId: "demo", testOnlyRequired: true });
    const text = renderVaultIndex(resolved);
    expect(text).not.toContain("s3cret");
    expect(text).toContain("$LO_VAULT_SANDBOX_TOKEN");
    expect(text).toContain("EMPTY — raise a doubt");
    expect(text).toContain("60 rpm");
  });
});
