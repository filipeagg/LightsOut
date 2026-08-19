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

/** A folder that holds documents and no manifest: offered for adoption, not rejected (KB-10). */
export type AdoptableFolder = {
  /** Relative to the workspace root, forward slashes. */
  path: string;
  /** What the base would be called; the folder's own name. */
  suggestedId: string;
  documents: number;
  /** Whether it already has an index in any case, which adoption then leaves alone. */
  hasIndex: boolean;
};

/** One document that matches a search, with enough context to decide whether to read it (KB-13). */
export type KnowledgeHit = {
  baseId: string;
  kind: string;
  file: string;
  line: number;
  excerpt: string;
};

export type KnowledgeLoadReport = {
  loaded: number;
  rejected: RejectedBase[];
  adoptable: AdoptableFolder[];
};

export const MANIFEST_FILE = "knowledge.yaml";
export const INDEX_FILE = "index.md";

/** A base is a tree, not a flat list (KB-09), but a bounded one. */
const MAX_DEPTH = 8;
const MAX_DOCUMENTS = 500;

/** Long enough to answer from, short enough that twenty hits are still a list (KB-13). */
const MAX_EXCERPT = 400;

/** Lowercase and strip diacritics so `vademecum` finds `Vademécum`. */
function fold(text: string): string {
  // The class is written with escapes on purpose: combining marks are invisible in an editor.
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * The base's index, by whatever case it was written in. A folder that arrived with `INDEX.md`
 * keeps it: the container's filesystem is case-sensitive and the person who wrote it was not.
 */
export async function findIndexFile(dir: string): Promise<string | undefined> {
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === INDEX_FILE) return entry.name;
    }
  } catch {
    // No directory, no index.
  }
  return undefined;
}

/**
 * Every text document under `root`, depth first, identified by its path inside the base
 * (`technical/api-auth.md`). That path is how the person who organised the folder said what the
 * document is about, so it travels with it instead of being flattened away (KB-09).
 */
export async function scanDocuments(
  root: string,
  skipAtRoot?: string,
): Promise<KnowledgeDocument[]> {
  const documents: KnowledgeDocument[] = [];

  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || documents.length >= MAX_DOCUMENTS) return;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (documents.length >= MAX_DOCUMENTS) return;
      // Hidden directories and dependency trees are not documentation, whoever dropped them here.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isDocumentFile(entry.name)) continue;
      if (relative === "" && skipAtRoot !== undefined && entry.name === skipAtRoot) continue;
      const info = await stat(path.join(root, child));
      documents.push({
        file: child,
        bytes: info.size,
        updated: new Date(info.mtimeMs).toISOString(),
      });
    }
  };

  await walk("", 0);
  documents.sort((a, b) => a.file.localeCompare(b.file));
  return documents;
}

/** The index lives with the manifest, except in a folder adopted in place, where both are together. */
async function readIndex(dir: string, docsDir: string): Promise<string | undefined> {
  for (const root of dir === docsDir ? [dir] : [dir, docsDir]) {
    const name = await findIndexFile(root);
    if (name !== undefined) {
      try {
        return await readFile(path.join(root, name), "utf8");
      } catch {
        // Unreadable is the same as absent for the prompt's purposes.
      }
    }
  }
  return undefined;
}

export class KnowledgeLoader {
  private bases = new Map<string, KnowledgeBase>();
  private rejected: RejectedBase[] = [];
  private adoptableFolders: AdoptableFolder[] = [];

  constructor(private readonly workspace: string) {}

  get knowledgeDir(): string {
    return path.join(this.workspace, "knowledge");
  }

  /**
   * Do this base's documents live inside the knowledge area? (KB-05 amended, §17.1b)
   *
   * The reason a linked base may not be written to is that the folder belongs to something else —
   * the user's own source tree, another project. A folder under `knowledge/` belongs to the
   * knowledge area, and `knowledge/acmecorp/mercado` is as curatable as `knowledge/mercado`.
   * Nesting was never the reason for the ban; it only looked like it, because "directly under
   * knowledge/" was how a base in place was recognised.
   */
  ownsItsDocuments(baseId: string): boolean {
    const base = this.getOrThrow(baseId);
    const root = path.resolve(this.knowledgeDir);
    const docs = path.resolve(base.docsDir);
    return docs === root || docs.startsWith(root + path.sep);
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

  /** Folders under `knowledge/` that hold documents and no manifest yet (KB-10). */
  adoptable(): AdoptableFolder[] {
    return this.adoptableFolders;
  }

  /**
   * Read one document, refusing anything that escapes the base. The MCP `read_knowledge`
   * tool and the prompt builder both go through here so the check exists once.
   */
  async readDocument(baseId: string, file: string): Promise<string> {
    const base = this.getOrThrow(baseId);
    // Documents live under `docsDir`; the manifest and the index live with the base. Both roots
    // are tried, and each is checked on its own, so a `..` cannot walk out through either.
    const roots = base.dir === base.docsDir ? [base.dir] : [base.docsDir, base.dir];
    let lastError: unknown;
    for (const root of roots) {
      const target = path.resolve(root, file);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`path escapes the knowledge base: ${file}`);
      }
      try {
        return await readFile(target, "utf8");
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`cannot read ${file} in ${baseId}`);
  }

  /**
   * Text search across curated documents (KB-13). Case- and accent-insensitive, because the
   * documents are written in Spanish and nobody types `Vademécum` with the accent when asking.
   * Returns the matching line with one line of context either side, labelled by base and file,
   * so the caller can quote it or go read the document whole.
   */
  async search(
    query: string,
    opts: { baseId?: string; limit?: number } = {},
  ): Promise<KnowledgeHit[]> {
    const needle = fold(query);
    if (needle.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const bases = opts.baseId ? [this.getOrThrow(opts.baseId)] : this.list();
    const hits: KnowledgeHit[] = [];

    for (const base of bases) {
      for (const doc of base.documents) {
        if (hits.length >= limit) return hits;
        // A document that cannot be read is not a reason to fail the whole search: the folder is
        // the user's own and a file can vanish between the scan and the query.
        const content = await this.readDocument(base.manifest.id, doc.file).catch(() => undefined);
        if (content === undefined) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (!fold(lines[i] ?? "").includes(needle)) continue;
          hits.push({
            baseId: base.manifest.id,
            kind: base.manifest.kind,
            file: doc.file,
            line: i + 1,
            excerpt: lines
              .slice(Math.max(0, i - 1), i + 2)
              .join("\n")
              .trim()
              .slice(0, MAX_EXCERPT),
          });
          // One hit per document: the point is to say which document to read, not to paste it.
          break;
        }
      }
    }
    return hits;
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

    const adoptable: AdoptableFolder[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.knowledgeDir, entry.name);

      // KB-10: a folder of documents with no manifest is an invitation, not an error. Report it
      // as adoptable so the panel can offer to write what is missing, instead of showing the
      // person who dropped their documentation in here a red rejection.
      const manifestRaw = await readFile(path.join(dir, MANIFEST_FILE), "utf8").catch(
        () => undefined,
      );
      if (manifestRaw === undefined) {
        const documents = await scanDocuments(dir);
        adoptable.push({
          path: `knowledge/${entry.name}`,
          suggestedId: entry.name,
          documents: documents.length,
          hasIndex: (await findIndexFile(dir)) !== undefined,
        });
        continue;
      }

      try {
        const raw = loadYaml(manifestRaw);
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

        // KB-09: a base is a tree. The index is the only file skipped, and only at the root.
        const indexName = await findIndexFile(docsDir);
        const documents = await scanDocuments(docsDir, docsDir === dir ? indexName : undefined);

        const index = await readIndex(dir, docsDir);

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
    this.adoptableFolders = adoptable.sort((a, b) => a.path.localeCompare(b.path));
    return { loaded: bases.size, rejected, adoptable: this.adoptableFolders };
  }
}
