/**
 * PM-14 / KB-14 / VT-09 (§9.7.3): the project bundle.
 *
 * What is worth testing here is not that a zip round-trips — it is the three refusals that make
 * the file safe to hand to somebody: it carries no project file, it carries no credential value,
 * and importing it never overwrites what the receiving machine already has.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { AgentsLoader } from "../src/agents/loader.js";
import { KnowledgeLoader } from "../src/knowledge/loader.js";
import { TemplatesLoader } from "../src/templates/loader.js";
import { buildZip, readZip } from "../src/http/zip.js";
import {
  BUNDLE_MANIFEST,
  assertNoSecrets,
  BundleLeakError,
  exportBundle,
  importBundle,
  openBundle,
} from "../src/projects/bundle.js";
import type { ProjectRow } from "../src/db/types.js";
import type { VaultEntry } from "../src/vault/schema.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lo-bundle-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: "consultant-portal",
    name: "Consultant Portal",
    path: path.join(workspace, "projects", "consultant-portal"),
    context: "goal: a portal",
    repo_remote: "git@example.com:acme/consultant-portal.git",
    push_policy: "manual",
    policy_pack: "default",
    verify_cmd: null,
    template_id: null,
    template_reason: null,
    unattended: 1,
    archived: 0,
    created_at: "2026-09-06T00:00:00Z",
    ...overrides,
  };
}

const JIRA: VaultEntry = {
  id: "jira",
  label: "Jira",
  base_url: "https://acme.atlassian.net",
  auth: "bearer",
  test_only: false,
  scope: ["consultant-portal"],
  fields: { email: "someone@acme.com", token: "s3cr3t-token-value-long-enough" },
};

async function plantBase(id: string, body = "# Core\nrule: one\n"): Promise<void> {
  const dir = path.join(workspace, "knowledge", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "knowledge.yaml"),
    `id: ${id}\nname: ${id}\nkind: technical\n`,
    "utf8",
  );
  await writeFile(path.join(dir, "index.md"), body, "utf8");
}

async function loaders() {
  const agents = new AgentsLoader(workspace);
  const knowledge = new KnowledgeLoader(workspace);
  const templates = new TemplatesLoader(workspace, () => true);
  await agents.load();
  await knowledge.load();
  await templates.load();
  return { agents, knowledge, templates };
}

describe("the zip reader is the writer's inverse", () => {
  it("round-trips names and bytes, deflated or stored", () => {
    const entries = [
      { name: "bundle.yaml", data: Buffer.from("format: 1\n") },
      { name: "knowledge/a/index.md", data: Buffer.from("x".repeat(5000)) },
      { name: "agents/b.yaml", data: Buffer.from("") },
    ];
    const read = readZip(buildZip(entries));
    expect(read.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    expect(read[1]!.data.toString()).toBe("x".repeat(5000));
  });

  it("refuses something that is not an archive", () => {
    expect(() => readZip(Buffer.from("not a zip at all"))).toThrow(/not a zip archive/);
  });
});

describe("what the bundle carries (PM-14)", () => {
  it("carries the dependencies and not one file of the project", async () => {
    await plantBase("acme-core");
    await mkdir(path.join(workspace, "agents"), { recursive: true });
    await writeFile(
      path.join(workspace, "agents", "house-builder.yaml"),
      "id: house-builder\nname: House builder\nengine: claude\nprompt: build\n",
      "utf8",
    );
    await mkdir(path.join(workspace, "projects", "consultant-portal"), { recursive: true });
    await writeFile(
      path.join(workspace, "projects", "consultant-portal", "lightsout.yaml"),
      "name: Consultant Portal\ncontext: |\n  goal: a portal\n",
      "utf8",
    );
    await writeFile(
      path.join(workspace, "projects", "consultant-portal", "secret-code.ts"),
      "export const x = 1;",
      "utf8",
    );
    const deps = await loaders();

    const bundle = await exportBundle(
      {
        project: project(),
        agentIds: ["house-builder", "contract-prober"],
        knowledgeIds: ["acme-core"],
        vaultIds: ["jira"],
      },
      { workspace, ...deps, vaultEntries: async () => [JIRA], version: "0.2.2" },
    );

    const names = readZip(bundle.data).map((entry) => entry.name);
    expect(names).toContain(BUNDLE_MANIFEST);
    expect(names).toContain("knowledge/acme-core/index.md");
    expect(names).toContain("agents/house-builder.yaml");
    // No file of the project, and nothing for an agent profile that is not in the workspace.
    expect(names.some((name) => name.includes("secret-code"))).toBe(false);
    expect(names.some((name) => name.startsWith("projects/"))).toBe(false);
    expect(names).not.toContain("agents/contract-prober.yaml");

    // The declaration travels as text inside the manifest, for a machine with no clone yet.
    expect(bundle.manifest.project.declaration).toContain("goal: a portal");
    expect(bundle.filename).toBe("consultant-portal.lobundle");
  });

  it("names credentials and holds none (VT-09)", async () => {
    const deps = await loaders();
    const bundle = await exportBundle(
      { project: project(), agentIds: [], knowledgeIds: [], vaultIds: ["jira"] },
      { workspace, ...deps, vaultEntries: async () => [JIRA], version: "0.2.2" },
    );

    const entry = bundle.manifest.requires.vault[0]!;
    expect(entry.fields).toEqual(["email", "token"]);
    expect(entry.base_url).toBe("https://acme.atlassian.net");
    expect(bundle.data.includes("s3cr3t-token-value-long-enough")).toBe(false);
  });

  it("aborts rather than exporting a stored value that slipped in", () => {
    expect(() =>
      assertNoSecrets(
        [{ name: "knowledge/leaky/index.md", data: Buffer.from("token: s3cr3t-token-value-long-enough") }],
        [JIRA],
      ),
    ).toThrow(BundleLeakError);
  });

  it("carries a base that reads a folder inside knowledge/, documents and all (KB-14)", async () => {
    // The case that broke the first live export: a `source:` under `knowledge/` is still the
    // knowledge area, so the base is the system's to carry — and it is two trees, not one.
    await mkdir(path.join(workspace, "knowledge", "company", "tech"), { recursive: true });
    await writeFile(path.join(workspace, "knowledge", "company", "tech", "a.md"), "# A", "utf8");
    const dir = path.join(workspace, "knowledge", "nested");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "knowledge.yaml"),
      "id: nested\nname: Nested\nkind: technical\nsource: knowledge/company/tech\n",
      "utf8",
    );
    const deps = await loaders();

    const bundle = await exportBundle(
      { project: project(), agentIds: [], knowledgeIds: ["nested"], vaultIds: [] },
      { workspace, ...deps, version: "0.2.2" },
    );

    const declared = bundle.manifest.requires.knowledge[0]!;
    expect(declared.bundled).toBe(true);
    expect(declared.paths.sort()).toEqual(["knowledge/company/tech", "knowledge/nested"]);
    const names = readZip(bundle.data).map((entry) => entry.name);
    expect(names).toContain("knowledge/nested/knowledge.yaml");
    expect(names).toContain("knowledge/company/tech/a.md");

    // And it lands on the other machine as the same two trees, so `source:` still resolves.
    const other = await mkdtemp(path.join(tmpdir(), "lo-bundle-nested-"));
    try {
      const agents = new AgentsLoader(other);
      const knowledge = new KnowledgeLoader(other);
      await agents.load();
      await knowledge.load();
      const result = await importBundle(bundle.data, { workspace: other, agents, knowledge });
      expect(result.knowledge.written).toEqual(["nested"]);
      expect(await readFile(path.join(other, "knowledge", "company", "tech", "a.md"), "utf8")).toBe(
        "# A",
      );
      expect(knowledge.get("nested")?.documents).toHaveLength(1);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("declares a base reading a folder outside knowledge/ instead of copying it (KB-14)", async () => {
    await mkdir(path.join(workspace, "docs", "platform"), { recursive: true });
    await writeFile(path.join(workspace, "docs", "platform", "a.md"), "# A", "utf8");
    const dir = path.join(workspace, "knowledge", "linked");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "knowledge.yaml"),
      "id: linked\nname: Linked\nkind: technical\nsource: docs/platform\n",
      "utf8",
    );
    const deps = await loaders();

    const bundle = await exportBundle(
      { project: project(), agentIds: [], knowledgeIds: ["linked"], vaultIds: [] },
      { workspace, ...deps, version: "0.2.2" },
    );

    const declared = bundle.manifest.requires.knowledge[0]!;
    expect(declared.bundled).toBe(false);
    expect(declared.source).toBe("docs/platform");
    expect(readZip(bundle.data).some((entry) => entry.name.startsWith("knowledge/linked/"))).toBe(
      false,
    );
  });
});

describe("importing one (PM-14, KB-14)", () => {
  it("writes what is absent and leaves what is there alone", async () => {
    await plantBase("acme-core", "# Core\nrule: one\n");
    const source = await loaders();
    const bundle = await exportBundle(
      { project: project(), agentIds: [], knowledgeIds: ["acme-core"], vaultIds: ["jira"] },
      { workspace, ...source, vaultEntries: async () => [JIRA], version: "0.2.2" },
    );

    // A second machine: empty workspace, same archive.
    const other = await mkdtemp(path.join(tmpdir(), "lo-bundle-other-"));
    try {
      const agents = new AgentsLoader(other);
      const knowledge = new KnowledgeLoader(other);
      await agents.load();
      await knowledge.load();
      const created: string[] = [];

      const first = await importBundle(bundle.data, {
        workspace: other,
        agents,
        knowledge,
        vaultViews: async () => [],
        createVaultEntry: async (entry) => {
          created.push(`${entry.id}:${entry.fields.join(",")}`);
        },
      });

      expect(first.knowledge.written).toEqual(["acme-core"]);
      expect(first.vault.created).toEqual(["jira"]);
      // VT-09: the entry is created as a form, with the field names and nothing in them.
      expect(created).toEqual(["jira:email,token"]);
      expect(
        await readFile(path.join(other, "knowledge", "acme-core", "index.md"), "utf8"),
      ).toContain("rule: one");

      // Second import: the base is there now, and an archive never overwrites one (KB-14).
      await writeFile(
        path.join(other, "knowledge", "acme-core", "index.md"),
        "# Core\nrule: two\n",
        "utf8",
      );
      const second = await importBundle(bundle.data, {
        workspace: other,
        agents,
        knowledge,
        vaultViews: async () => [
          { id: "jira", label: "Jira", auth: "bearer", test_only: false, scope: ["*"], fields: [] },
        ],
      });

      expect(second.knowledge.written).toEqual([]);
      expect(second.knowledge.skipped).toEqual([{ id: "acme-core", differs: true }]);
      expect(second.vault.existing).toEqual(["jira"]);
      expect(
        await readFile(path.join(other, "knowledge", "acme-core", "index.md"), "utf8"),
      ).toContain("rule: two");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("refuses an archive that carries a project file", () => {
    const manifest = [
      "format: 1",
      "project:",
      "  id: consultant-portal",
      "requires: { knowledge: [], agents: [], templates: [], vault: [] }",
      "",
    ].join("\n");
    const archive = buildZip([
      { name: BUNDLE_MANIFEST, data: Buffer.from(manifest) },
      { name: "projects/consultant-portal/src/index.html", data: Buffer.from("<p>no</p>") },
    ]);

    expect(() => openBundle(archive)).toThrow(/nothing of the project itself/);
  });

  it("refuses a path that escapes the archive", () => {
    const archive = buildZip([
      { name: BUNDLE_MANIFEST, data: Buffer.from("format: 1\nproject: { id: p }\n") },
      { name: "knowledge/../../../etc/passwd", data: Buffer.from("no") },
    ]);

    expect(() => openBundle(archive)).toThrow(/escapes it/);
  });

  it("refuses a format it does not read", () => {
    const archive = buildZip([
      { name: BUNDLE_MANIFEST, data: Buffer.from("format: 99\nproject: { id: p }\n") },
    ]);

    expect(() => openBundle(archive)).toThrow(/format 99/);
  });

  it("keeps the manifest readable as plain YAML", async () => {
    const deps = await loaders();
    const bundle = await exportBundle(
      { project: project(), agentIds: [], knowledgeIds: [], vaultIds: [] },
      { workspace, ...deps, version: "0.2.2" },
    );
    const raw = readZip(bundle.data).find((entry) => entry.name === BUNDLE_MANIFEST)!;
    const parsed = loadYaml(raw.data.toString("utf8")) as Record<string, unknown>;
    expect(parsed.format).toBe(1);
  });
});
