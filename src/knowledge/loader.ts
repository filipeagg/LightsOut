/**
 * Curated knowledge base scanning (KB-01, KB-02, DESIGN §17.1).
 *
 * A base is a directory under `$WORKSPACE/knowledge/` with a `knowledge.yaml` manifest whose
 * id equals the directory name, an `index.md` table of contents, and its documents. There is
 * no builtin layer here: knowledge belongs to the installation, not to the image.
 */
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  isDocumentFile,
  knowledgeManifestSchema,
  resolveSource,
  type KnowledgeManifest,
  type RejectedBase,
} from "./schema.js";

export type KnowledgeDocument = {
  /** Path relative to the base directory, e.g. `data-model.md`. */
  file: string;
  bytes: number;
  updated: string;
};

export type KnowledgeBase = {
  manifest: KnowledgeManifest;
  /** Where the manifest and `index.md` live: always `knowledge/<id>/`. */
  dir: string;
  /**
   * Where the documents live. The same as `dir` for a normal base, and the linked folder for one
   * with `source` set (KB-08). Everything that reads or writes a document uses this.
   */
  docsDir: string;
  /** Set when the documents come from elsewhere, so the panel and the agent can say so. */
  source: string | undefined;
  /** Present when the base has one; always injected in full when it does (§17.2). */
  index: string | undefined;
  documents: KnowledgeDocument[];
};

export type KnowledgeLoadReport = {
  loaded: number;
  rejected: RejectedBase[];
};

export const MANIFEST_FILE = "knowledge.yaml";
export const INDEX_FILE = "index.md";

export class KnowledgeLoader {
  private bases = new Map<string, KnowledgeBase>();
  private rejected: RejectedBase[] = [];

  constructor(private readonly workspace: string) {}

  get knowledgeDir(): string {
    return path.join(this.workspace, "knowledge");
  }

  list(): KnowledgeBase[] {
    return [...this.bases.values()].sort((a, b) =>
      a.manifest.id.localeCompare(b.manifest.id),
    );
  }

  get(id: string): KnowledgeBase | undefined {
    return this.bases.get(id);
  }

  getOrThrow(id: string): KnowledgeBase {
    const found = this.get(id);
    if (found) return found;
    const known = this.list().map((b) => b.manifest.id).join(", ") || "none";
    throw new Error(`unknown knowledge base: ${id} (available: ${known})`);
  }

  rejections(): RejectedBase[] {
    return this.rejected;
  }

  /**
   * Read one document, refusing anything that escapes the base. The MCP `read_knowledge`
   * tool and the prompt builder both go through here so the check exists once.
   */
  async readDocument(baseId: string, file: string): Promise<string> {
    const base = this.getOrThrow(baseId);
    // `index.md` and the manifest live in the base directory even when the documents do not.
    const root = file === INDEX_FILE || file === MANIFEST_FILE ? base.dir : base.docsDir;
    const target = path.resolve(root, file);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`path escapes the knowledge base: ${file}`);
    }
    return readFile(target, "utf8");
  }

  async load(): Promise<KnowledgeLoadReport> {
    await mkdir(this.knowledgeDir, { recursive: true });
    const bases = new Map<string, KnowledgeBase>();
    const rejected: RejectedBase[] = [];

    let entries: Dirent[] = [];
    try {
      entries = await readdir(this.knowledgeDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.knowledgeDir, entry.name);
      try {
        const raw = loadYaml(await readFile(path.join(dir, MANIFEST_FILE), "utf8"));
        if (raw === null || typeof raw !== "object") {
          throw new Error(`${MANIFEST_FILE} is empty or not a YAML mapping`);
        }
        const manifest = knowledgeManifestSchema.parse({
          id: entry.name,
          ...(raw as Record<string, unknown>),
        });
        if (manifest.id !== entry.name) {
          throw new Error(
            `manifest id ${manifest.id} does not match the directory name ${entry.name}`,
          );
        }

        // A linked base reads its documents from a folder elsewhere in the workspace (KB-08).
        // A source that cannot be resolved rejects the base rather than silently emptying it.
        let docsDir = dir;
        if (manifest.source !== undefined) {
          const resolved = resolveSource(this.workspace, manifest.source);
          if ("error" in resolved) throw new Error(resolved.error);
          const info = await stat(resolved.dir).catch(() => undefined);
          if (!info?.isDirectory()) {
            throw new Error(`source folder does not exist in the workspace: ${manifest.source}`);
          }
          docsDir = resolved.dir;
        }

        const documents: KnowledgeDocument[] = [];
        for (const file of await readdir(docsDir, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          if (!isDocumentFile(file.name)) continue;
          if (docsDir === dir && file.name === INDEX_FILE) continue;
          const info = await stat(path.join(docsDir, file.name));
          documents.push({
            file: file.name,
            bytes: info.size,
            updated: new Date(info.mtimeMs).toISOString(),
          });
        }
        documents.sort((a, b) => a.file.localeCompare(b.file));

        let index: string | undefined;
        try {
          index = await readFile(path.join(dir, INDEX_FILE), "utf8");
        } catch {
          index = undefined;
        }

        bases.set(manifest.id, {
          manifest,
          dir,
          docsDir,
          source: manifest.source,
          index,
          documents,
        });
      } catch (err) {
        rejected.push({
          dir: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.bases = bases;
    this.rejected = rejected;
    return { loaded: bases.size, rejected };
  }
}
