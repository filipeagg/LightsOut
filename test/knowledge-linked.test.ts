/**
 * Linked knowledge bases and the document formats they accept (KB-08).
 *
 * The interesting part is the refusals: `source` arrives from a browser, and the container only
 * sees the workspace (RT-02), so a path that climbs out of it or points into `knowledge/` has to
 * be rejected rather than resolved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeLoader } from "../src/knowledge/loader.js";
import { KnowledgeWriter, listWorkspaceFolders } from "../src/knowledge/writer.js";
import { isDocumentFile, resolveSource } from "../src/knowledge/schema.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "lo-kb8-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const write = async (relative: string, body: string) => {
  const file = path.join(workspace, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
};

describe("resolveSource (KB-08)", () => {
  it("accepts a folder inside the workspace", () => {
    const result = resolveSource(workspace, "docs/platform");
    expect(result).toEqual({ dir: path.resolve(workspace, "docs/platform") });
  });

  it("normalises separators and a trailing slash", () => {
    expect(resolveSource(workspace, "./docs\\platform/")).toEqual({
      dir: path.resolve(workspace, "docs/platform"),
    });
  });

  it("refuses what it cannot see or must not touch", () => {
    for (const bad of ["/etc", "C:/Windows", "../outside", "..", "knowledge", "knowledge/other"]) {
      const result = resolveSource(workspace, bad);
      expect(result, bad).toHaveProperty("error");
    }
    expect(resolveSource(workspace, ".")).toHaveProperty("error");
  });
});

describe("document formats (KB-08)", () => {
  it("takes text and nothing else", () => {
    for (const good of ["a.md", "a.markdown", "notes.txt", "A.MD"]) {
      expect(isDocumentFile(good), good).toBe(true);
    }
    for (const bad of ["a.pdf", "a.docx", "a.png", "README", "a.md.zip"]) {
      expect(isDocumentFile(bad), bad).toBe(false);
    }
  });

  it("refuses a non-text document with the list of extensions", async () => {
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.putManifest("base", { name: "Base", kind: "technical" });

    await expect(writer.putDocument("base", "spec.pdf", "x")).rejects.toThrow(/text file/);
    await expect(writer.putDocument("base", "../escape.md", "x")).rejects.toThrow(/escapes/);
    expect(await writer.putDocument("base", "notes.txt", "hello")).toBe("notes.txt");

    // Writing into a name that is not a base would leave a directory with a document and no
    // manifest, which the loader reports as a rejection. Refuse instead.
    await expect(writer.putDocument("nope", "a.md", "x")).rejects.toThrow(/unknown knowledge base/);
  });
});

describe("a linked base", () => {
  it("reads its documents from the folder and keeps its own index", async () => {
    await write("docs/platform/data-model.md", "# tables");
    await write("docs/platform/rules.txt", "no negative stock");
    await write("docs/platform/diagram.png", "not text");

    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.putManifest("platform", {
      name: "Platform docs",
      kind: "technical",
      source: "docs/platform",
    });

    const base = loader.getOrThrow("platform");
    expect(base.source).toBe("docs/platform");
    expect(base.dir).toBe(path.join(workspace, "knowledge", "platform"));
    expect(base.docsDir).toBe(path.resolve(workspace, "docs/platform"));
    expect(base.documents.map((d) => d.file)).toEqual(["data-model.md", "rules.txt"]);
    expect(base.index).toContain("Platform docs");
    expect(await loader.readDocument("platform", "data-model.md")).toBe("# tables");
  });

  it("sees a file dropped into the folder on the next load", async () => {
    await write("docs/platform/one.md", "one");
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.putManifest("platform", { name: "D", kind: "technical", source: "docs/platform" });
    expect(loader.getOrThrow("platform").documents).toHaveLength(1);

    await write("docs/platform/two.md", "two");
    await loader.load();
    expect(loader.getOrThrow("platform").documents.map((d) => d.file)).toEqual([
      "one.md",
      "two.md",
    ]);
  });

  it("refuses a source that does not exist, and one that escapes", async () => {
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();

    await expect(
      writer.putManifest("b1", { name: "B", kind: "other", source: "docs/missing" }),
    ).rejects.toThrow(/no such folder/);
    await expect(
      writer.putManifest("b2", { name: "B", kind: "other", source: "../outside" }),
    ).rejects.toThrow(/escapes/);
  });

  it("will not let a document be deleted through it", async () => {
    await write("docs/platform/one.md", "one");
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.putManifest("platform", { name: "D", kind: "technical", source: "docs/platform" });

    await expect(writer.removeDocument("platform", "one.md")).rejects.toThrow(/delete the file there/);
    // Deleting the base leaves the linked folder alone: it pointed at it, it never owned it.
    await writer.remove("platform", []);
    await loader.load();
    expect(loader.get("platform")).toBeUndefined();
    expect(await loader.list()).toHaveLength(0);
    await write("docs/platform/still-here.md", "yes");
  });

  it("unlinks back to its own folder when source is null", async () => {
    await write("docs/platform/one.md", "one");
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.putManifest("platform", { name: "D", kind: "technical", source: "docs/platform" });
    expect(loader.getOrThrow("platform").documents).toHaveLength(1);

    await writer.putManifest("platform", { source: null });
    const base = loader.getOrThrow("platform");
    expect(base.source).toBeUndefined();
    expect(base.docsDir).toBe(base.dir);
    expect(base.documents).toHaveLength(0);
  });
});

describe("listWorkspaceFolders (KB-08)", () => {
  it("walks the whole tree in render order and hides LightsOut's own folders", async () => {
    await write("docs/platform/2026/q1.md", "q1");
    await write("docs/platform/a.md", "a");
    await write("docs/platform/notes.txt", "n");
    await write("docs/platform/diagram.png", "not text");
    await write("docs/reports/b.md", "b");
    await write("notes/c.md", "c");
    await write("knowledge/base/knowledge.yaml", "name: x\nkind: other\n");
    await write("projects/p1/README.md", "p");
    await write(".hidden/x.md", "x");
    await write("docs/node_modules/pkg/index.md", "no");

    const folders = await listWorkspaceFolders(workspace);
    // Depth first, alphabetical, so the list reads as the tree renders — no depth limit.
    expect(folders.map((f) => f.path)).toEqual([
      "docs",
      "docs/platform",
      "docs/platform/2026",
      "docs/reports",
      "notes",
    ]);

    const platform = folders.find((f) => f.path === "docs/platform")!;
    expect(platform.name).toBe("platform");
    expect(platform.depth).toBe(1);
    // Only text files it holds directly: what linking here would actually give an agent.
    expect(platform.documents).toBe(2);
    expect(platform.hasChildren).toBe(true);

    const docs = folders.find((f) => f.path === "docs")!;
    expect(docs.depth).toBe(0);
    expect(docs.documents).toBe(0);
    expect(folders.find((f) => f.path === "notes")!.hasChildren).toBe(false);
  });
});
