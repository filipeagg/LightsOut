/**
 * Panel-driven knowledge writing (KB-01, KB-05, DESIGN §17).
 *
 * There is no builtin layer here: a base belongs to the installation. Writes go straight into
 * `$WORKSPACE/knowledge/<id>/`, and every document path is checked against the base directory
 * before it is touched, because the id and the path both arrive from a browser.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import { stat } from "node:fs/promises";
import {
  DOCUMENT_EXTENSIONS,
  isDocumentFile,
  knowledgeManifestSchema,
  resolveSource,
  type KnowledgeManifest,
} from "./schema.js";
import { INDEX_FILE, MANIFEST_FILE, type KnowledgeLoader } from "./loader.js";

/** `source: null` unlinks a base and sends it back to holding its own documents (KB-08). */
export type ManifestPatch = Partial<Omit<KnowledgeManifest, "id" | "source">> & {
  source?: string | null;
};

/**
 * Folders inside the workspace a base could be linked to (KB-08), two levels deep so
 * `docs/erpagro` is offered as well as `docs`. `knowledge/`, `projects/`, `agents/`, `templates/`
 * and anything hidden are left out: they belong to LightsOut, not to the user's documents.
 */
export async function listWorkspaceFolders(workspace: string): Promise<string[]> {
  const reserved = new Set(["knowledge", "projects", "agents", "templates", "node_modules"]);
  const found: string[] = [];

  const walk = async (relative: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (relative === "" && reserved.has(entry.name)) continue;
      found.push(child);
      if (depth > 0) await walk(child, depth - 1);
    }
  };

  await walk("", 1);
  return found.sort();
}

export class KnowledgeWriter {
  constructor(private readonly loader: KnowledgeLoader) {}

  private dir(baseId: string): string {
    const target = path.resolve(this.loader.knowledgeDir, baseId);
    const root = path.resolve(this.loader.knowledgeDir);
    if (path.dirname(target) !== root) {
      throw new Error(`invalid knowledge base id: ${baseId}`);
    }
    return target;
  }

  /** The workspace root, which is what a linked `source` is resolved against (KB-08). */
  private get workspace(): string {
    return path.dirname(path.resolve(this.loader.knowledgeDir));
  }

  /** Create a base, or update its manifest. An index.md is seeded so injection has one (§17.2). */
  async putManifest(baseId: string, patch: ManifestPatch): Promise<KnowledgeManifest> {
    const current = this.loader.get(baseId)?.manifest;
    // `null` means "stop being linked"; `undefined` means "leave it as it was".
    const { source, ...rest } = patch;
    const manifest = knowledgeManifestSchema.parse({
      ...(current ?? { name: baseId, kind: "other" }),
      ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ...(source === undefined ? {} : source === null ? { source: undefined } : { source }),
      id: baseId,
      updated: patch.updated ?? new Date().toISOString().slice(0, 10),
    });

    // Validate the link before writing: a manifest naming a folder that is not there would
    // reject the whole base on the next load, and the panel would have nothing to explain it.
    if (manifest.source !== undefined) {
      const resolved = resolveSource(this.workspace, manifest.source);
      if ("error" in resolved) throw new Error(resolved.error);
      const info = await stat(resolved.dir).catch(() => undefined);
      if (!info?.isDirectory()) {
        throw new Error(
          `no such folder in the workspace: ${manifest.source} (it must already exist)`,
        );
      }
    }

    const dir = this.dir(baseId);
    await mkdir(dir, { recursive: true });
    const { id: _id, ...body } = manifest;
    await writeFile(path.join(dir, MANIFEST_FILE), dumpYaml(body, { lineWidth: 100 }), "utf8");
    if (!current) {
      await writeFile(
        path.join(dir, INDEX_FILE),
        `# ${manifest.name}\n\nOne line per document, saying what is in it.\n`,
        "utf8",
      );
    }
    await this.loader.load();
    return this.loader.getOrThrow(baseId).manifest;
  }

  /**
   * Write one document into the base, or into the folder it is linked to (KB-08). Text only:
   * what a base is for is text that goes into a prompt, so anything else is refused with the
   * list of extensions rather than stored as a file the agent is told about and cannot read.
   */
  async putDocument(baseId: string, file: string, content: string): Promise<string> {
    // The base has to exist first. Without this, writing a document to a name that is not a base
    // creates a directory holding one file and no manifest — which the loader then reports as a
    // rejected base, and the user is left with an error where they expected a document.
    const base = this.loader.getOrThrow(baseId);
    const dir = base.docsDir;
    const target = path.resolve(dir, file);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new Error(`path escapes the knowledge base: ${file}`);
    }
    if (!isDocumentFile(target)) {
      throw new Error(
        `a knowledge document must be a text file (${DOCUMENT_EXTENSIONS.join(", ")}): ${file}`,
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    await this.loader.load();
    return path.relative(dir, target);
  }

  /** Delete one document. Refused on a linked base: that folder belongs to something else. */
  async removeDocument(baseId: string, file: string): Promise<void> {
    const base = this.loader.getOrThrow(baseId);
    if (base.source !== undefined) {
      throw new Error(
        `${baseId} reads its documents from ${base.source}; delete the file there, not here`,
      );
    }
    const target = path.resolve(base.docsDir, file);
    if (!target.startsWith(base.docsDir + path.sep)) {
      throw new Error(`path escapes the knowledge base: ${file}`);
    }
    if (path.basename(target) === MANIFEST_FILE) {
      throw new Error("the manifest is not a document; delete the base instead");
    }
    await rm(target, { force: true });
    await this.loader.load();
  }

  /**
   * Delete a base. Refused while a project has it attached: a project's prompts would start
   * quietly missing context, which is worse than an error (KB-03).
   *
   * Only `knowledge/<id>/` goes — the manifest and the index. A linked folder is left exactly
   * where it is: the base pointed at it, it never owned it (KB-08).
   */
  async remove(baseId: string, attachedTo: string[]): Promise<void> {
    if (attachedTo.length > 0) {
      throw new Error(
        `${baseId} is attached to ${attachedTo.join(", ")}; detach it first (KB-03)`,
      );
    }
    await rm(this.dir(baseId), { recursive: true, force: true });
    await this.loader.load();
  }
}
