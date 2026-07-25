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
  knowledgeManifestSchema,
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
  dir: string;
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
    const target = path.resolve(base.dir, file);
    if (target !== base.dir && !target.startsWith(base.dir + path.sep)) {
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

        const documents: KnowledgeDocument[] = [];
        for (const file of await readdir(dir, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          if (path.extname(file.name).toLowerCase() !== ".md") continue;
          if (file.name === INDEX_FILE) continue;
          const info = await stat(path.join(dir, file.name));
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

        bases.set(manifest.id, { manifest, dir, index, documents });
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
