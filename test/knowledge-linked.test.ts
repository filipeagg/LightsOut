/**
 * Linked knowledge bases and the document formats they accept (KB-08).
 *
 * The interesting part is the refusals: `source` arrives from a browser, and the container only
 * sees the workspace (RT-02), so a path that climbs out of it or points into `knowledge/` has to
 * be rejected rather than resolved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

describe("a base is a tree (KB-09)", () => {
  it("finds documents in subfolders and keeps their path as the id", async () => {
    await write("knowledge/docs/knowledge.yaml", "name: Docs\nkind: technical\n");
    await write("knowledge/docs/INDEX.md", "- what is where");
    await write("knowledge/docs/top.md", "top");
    await write("knowledge/docs/technical/api-auth.md", "auth");
    await write("knowledge/docs/technical/deep/entities.md", "entities");
    await write("knowledge/docs/technical/diagram.png", "not text");
    await write("knowledge/docs/.hidden/skip.md", "skipped");

    const loader = new KnowledgeLoader(workspace);
    await loader.load();
    const base = loader.getOrThrow("docs");

    expect(base.documents.map((d) => d.file)).toEqual([
      "technical/api-auth.md",
      "technical/deep/entities.md",
      "top.md",
    ]);
    // The index is found whatever case it was written in, and is not listed as a document.
    expect(base.index).toContain("what is where");
    expect(await loader.readDocument("docs", "technical/deep/entities.md")).toBe("entities");
  });

  it("still refuses a path that climbs out of the base", async () => {
    await write("knowledge/docs/knowledge.yaml", "name: Docs\nkind: technical\n");
    await write("knowledge/docs/a.md", "a");
    const loader = new KnowledgeLoader(workspace);
    await loader.load();
    await expect(loader.readDocument("docs", "../../secret")).rejects.toThrow(/escapes/);
  });
});

describe("adopting a folder (KB-10)", () => {
  it("reports a folder of documents with no manifest as adoptable, not rejected", async () => {
    await write("knowledge/dropped/one.md", "one");
    await write("knowledge/dropped/sub/two.md", "two");

    const report = await new KnowledgeLoader(workspace).load();
    expect(report.rejected).toEqual([]);
    expect(report.adoptable).toEqual([
      { path: "knowledge/dropped", suggestedId: "dropped", documents: 2, hasIndex: false },
    ]);
  });

  it("adopts it in place, writing the manifest and nothing else it already had", async () => {
    await write("knowledge/dropped/INDEX.md", "- the index it came with");
    await write("knowledge/dropped/product/one.md", "one");

    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();

    const result = await writer.adopt("knowledge/dropped", {
      name: "Dropped documentation",
      kind: "technical",
    });
    expect(result.inPlace).toBe(true);

    const base = loader.getOrThrow("dropped");
    expect(base.source).toBeUndefined();
    expect(base.docsDir).toBe(base.dir);
    expect(base.documents.map((d) => d.file)).toEqual(["product/one.md"]);
    // The index it arrived with is kept; no second one is invented next to it.
    expect(base.index).toContain("the index it came with");
    const files = await readdir(path.join(workspace, "knowledge", "dropped"));
    expect(files.sort()).toEqual(["INDEX.md", "knowledge.yaml", "product"]);
  });

  it("adopts a folder outside knowledge/ by linking to it, leaving it untouched", async () => {
    await write("company/docs/one.md", "one");

    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();

    const result = await writer.adopt("company/docs", { id: "company", kind: "functional" });
    expect(result.inPlace).toBe(false);

    const base = loader.getOrThrow("company");
    expect(base.source).toBe("company/docs");
    expect(base.documents.map((d) => d.file)).toEqual(["one.md"]);
    // The folder is not ours: only the base directory gets files.
    expect((await readdir(path.join(workspace, "company", "docs"))).sort()).toEqual(["one.md"]);
  });

  it("refuses to adopt what is already a base, or a name that cannot be an id", async () => {
    await write("knowledge/dropped/one.md", "one");
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();
    await writer.adopt("knowledge/dropped", { kind: "other" });

    await expect(writer.adopt("knowledge/dropped", { kind: "other" })).rejects.toThrow(
      /already a knowledge base/,
    );
    await expect(writer.adopt("docs/Not An Id", { kind: "other" })).rejects.toThrow(
      /cannot be a base id/,
    );
    await expect(writer.adopt("knowledge/missing", { kind: "other" })).rejects.toThrow(
      /no such folder/,
    );
  });

  it("refuses a folder nested inside knowledge/ that cannot be a base directory", async () => {
    await write("knowledge/tree/product/one.md", "one");
    const loader = new KnowledgeLoader(workspace);
    const writer = new KnowledgeWriter(loader);
    await loader.load();

    await expect(
      writer.adopt("knowledge/tree/product", { id: "product", kind: "other" }),
    ).rejects.toThrow(/move it to knowledge\/product/);
  });
});

describe("listWorkspaceFolders (KB-08, KB-10)", () => {
  it("shows the workspace as it really is, knowledge/ included", async () => {
    await write("docs/platform/2026/q1.md", "q1");
    await write("docs/platform/a.md", "a");
    await write("docs/platform/notes.txt", "n");
    await write("docs/platform/diagram.png", "not text");
    await write("docs/reports/b.md", "b");
    await write("notes/c.md", "c");
    await write("knowledge/base/knowledge.yaml", "name: x\nkind: other\n");
    await write("knowledge/dropped/deep/one.md", "d");
    await write("projects/p1/README.md", "p");
    await write(".hidden/x.md", "x");
    await write("docs/node_modules/pkg/index.md", "no");

    const folders = await listWorkspaceFolders(workspace, {
      basesByPath: new Map([["knowledge/base", "base"]]),
    });

    // Depth first, alphabetical, so the list reads as the tree renders. `knowledge/` is in:
    // someone who dropped their documentation there has to be able to see it (KB-10).
    expect(folders.map((f) => f.path)).toEqual([
      "docs",
      "docs/platform",
      "docs/platform/2026",
      "docs/reports",
      "knowledge",
      "knowledge/base",
      "knowledge/dropped",
      "knowledge/dropped/deep",
      "notes",
    ]);

    const platform = folders.find((f) => f.path === "docs/platform")!;
    expect(platform.name).toBe("platform");
    expect(platform.depth).toBe(1);
    // Subfolders count (KB-09): a.md, notes.txt and 2026/q1.md, not the png.
    expect(platform.documents).toBe(3);
    expect(platform.hasChildren).toBe(true);

    // A folder whose documents are all one level down used to report 0, which is what made the
    // picker look empty to someone whose documentation was organised.
    expect(folders.find((f) => f.path === "docs")!.documents).toBe(4);
    expect(folders.find((f) => f.path === "notes")!.hasChildren).toBe(false);
  });

  it("says which folders already are bases and which could be adopted in place", async () => {
    await write("knowledge/base/knowledge.yaml", "name: x\nkind: other\n");
    await write("knowledge/dropped/one.md", "d");
    await write("docs/elsewhere/two.md", "e");

    const folders = await listWorkspaceFolders(workspace, {
      basesByPath: new Map([["knowledge/base", "base"]]),
    });
    const at = (p: string) => folders.find((f) => f.path === p)!;

    expect(at("knowledge/base").baseId).toBe("base");
    expect(at("knowledge/base").adoptInPlace).toBeUndefined();

    // Directly under knowledge/, so adopting it writes the manifest there and nothing moves.
    expect(at("knowledge/dropped").adoptInPlace).toBe(true);
    expect(at("knowledge/dropped").baseId).toBeUndefined();

    // Outside knowledge/: adopting it means a base that links to it, not one in place.
    expect(at("docs/elsewhere").adoptInPlace).toBeUndefined();
  });
});
