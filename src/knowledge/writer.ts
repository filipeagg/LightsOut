/**
 * Panel-driven knowledge writing (KB-01, KB-05, DESIGN §17).
 *
 * There is no builtin layer here: a base belongs to the installation. Writes go straight into
 * `$WORKSPACE/knowledge/<id>/`, and every document path is checked against the base directory
 * before it is touched, because the id and the path both arrive from a browser.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { writeFileDurable } from "../workspace/durable.js";
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
import {
  findIndexFile,
  INDEX_FILE,
  MANIFEST_FILE,
  scanDocuments,
  type KnowledgeLoader,
} from "./loader.js";

/** `source: null` unlinks a base and sends it back to holding its own documents (KB-08). */
export type ManifestPatch = Partial<Omit<KnowledgeManifest, "id" | "source">> & {
  source?: string | null;
};

/** One folder in the workspace tree a base could be linked to or adopted from (KB-08, KB-10). */
export type WorkspaceFolder = {
  /** Path relative to the workspace root, forward slashes. */
  path: string;
  /** Just the folder name, so the panel can indent instead of repeating the parent. */
  name: string;
  /** How deep below the root it sits; the root's children are 0. */
  depth: number;
  /**
   * Text documents inside it, **counting subfolders** (KB-09). A folder whose documents are all
   * one level down is the normal case, and reporting 0 for it is what made the picker look empty.
   */
  documents: number;
  /** Whether it has folders of its own, so the tree knows what can be expanded. */
  hasChildren: boolean;
  /** The id of the base this folder already is, if any. */
  baseId?: string;
  /** Whether adopting it would make it a base in place, rather than linking to it (KB-10). */
  adoptInPlace?: boolean;
};

/**
 * The workspace tree as it really is, depth first, in the order a tree renders (KB-08, KB-10).
 *
 * There is no folder picker to offer instead: a browser cannot hand a server a path, and the
 * container's filesystem is the workspace and nothing else (RT-02) — a folder elsewhere on the
 * host is not forbidden, it is absent. So this walks what the container can actually open.
 *
 * `knowledge/` **is** included, and its children are marked with the base they already are or
 * flagged as adoptable in place: someone who dropped their documentation under `knowledge/` should
 * see it there rather than an empty picker. `projects/`, `agents/` and `templates/` are skipped at
 * the root — those are LightsOut's own. The walk is bounded (`MAX_FOLDERS`, `MAX_DEPTH`) so a
 * workspace with a stray dependency tree deep inside cannot hang the request.
 */
const MAX_FOLDERS = 2000;
const MAX_DEPTH = 12;

export type FolderContext = {
  /** Base ids by the folder path they occupy, so the tree can say "this already is one". */
  basesByPath?: Map<string, string>;
};

export async function listWorkspaceFolders(
  workspace: string,
  context: FolderContext = {},
): Promise<WorkspaceFolder[]> {
  const reserved = new Set(["projects", "agents", "templates"]);
  const bases = context.basesByPath ?? new Map<string, string>();
  const found: WorkspaceFolder[] = [];

  /**
   * One pass over the tree. Every folder is read exactly once and its document count is the sum
   * of what its children report, which is why this returns a total instead of pushing and moving
   * on. The obvious version — count each folder's subtree with its own recursive scan, and probe
   * each child again to see whether it has children — reads the same directories once per level
   * of nesting above them. On a Docker Desktop bind mount, where a readdir costs milliseconds
   * rather than microseconds, that turned a 309-folder workspace into a 4.5 s request and the
   * Knowledge view appeared to hang.
   */
  const walk = async (
    relative: string,
    depth: number,
  ): Promise<{ documents: number; hasFolders: boolean }> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FOLDERS) return { documents: 0, hasFolders: false };
    let entries;
    try {
      entries = await readdir(path.join(workspace, relative), { withFileTypes: true });
    } catch {
      return { documents: 0, hasFolders: false };
    }

    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .filter((e) => !(relative === "" && reserved.has(e.name)))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Documents sitting directly in this folder; the children add theirs below.
    let documents = entries.filter((e) => e.isFile() && isDocumentFile(e.name)).length;

    for (const entry of folders) {
      if (found.length >= MAX_FOLDERS) break;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const baseId = bases.get(child);
      const adoptInPlace = child.startsWith("knowledge/") && child.split("/").length === 2;

      // Pushed before the recursion so the list stays in pre-order, the order a tree renders;
      // the two numbers are filled in once the subtree has answered.
      const record: WorkspaceFolder = {
        path: child,
        name: entry.name,
        depth,
        documents: 0,
        hasChildren: false,
        ...(baseId ? { baseId } : {}),
        ...(baseId ? {} : adoptInPlace ? { adoptInPlace: true } : {}),
      };
      found.push(record);

      const sub = await walk(child, depth + 1);
      // Counting subfolders is the whole point (KB-09): a folder whose documents all sit one
      // level down is the normal case, and reporting 0 for it is what made the picker look empty.
      record.documents = sub.documents;
      record.hasChildren = sub.hasFolders;
      documents += sub.documents;
    }

    return { documents, hasFolders: folders.length > 0 };
  };

  await walk("", 0);
  return found;
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
    // Durable: the manifest *is* the base. A base created through the panel vanished because a
    // plain write to the bind mount had not reached the host when the container died (§11.2b).
    await writeFileDurable(path.join(dir, MANIFEST_FILE), dumpYaml(body, { lineWidth: 100 }));
    // Seed an index only when the folder has none — in any case, because a folder adopted in
    // place may have arrived with `INDEX.md` and a second `index.md` next to it would be a file
    // LightsOut invented on top of the user's own (KB-10).
    if ((await findIndexFile(dir)) === undefined) {
      await writeFileDurable(
        path.join(dir, INDEX_FILE),
        `# ${manifest.name}\n\nOne line per document, saying what is in it.\n`,
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
    await writeFileDurable(target, content);
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
   * Make an existing folder of documents usable as a base (KB-10), writing only what is missing.
   *
   * A folder under `knowledge/` becomes the base in place: the manifest is written next to the
   * documents and nothing moves. A folder anywhere else in the workspace gets a base in
   * `knowledge/<id>/` that links to it with `source`, so the folder stays untouched (KB-08).
   *
   * An index is written only when the folder has none in any case, and a folder that is already
   * a base is refused rather than overwritten. The folder is the user's and it was there first.
   */
  async adopt(
    folder: string,
    patch: Omit<ManifestPatch, "source"> & { id?: string },
  ): Promise<{ manifest: KnowledgeManifest; inPlace: boolean; hasIndex: boolean }> {
    const cleaned = folder.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const inKnowledge = cleaned === "knowledge" || cleaned.startsWith("knowledge/");
    const name = cleaned.split("/").filter(Boolean).pop() ?? "";
    const baseId = (patch.id ?? name).trim();

    if (!/^[a-z0-9][a-z0-9-]*$/.test(baseId)) {
      throw new Error(
        `"${baseId}" cannot be a base id: lowercase letters, digits and - only. Pass an id.`,
      );
    }
    if (this.loader.get(baseId)) {
      throw new Error(`${baseId} is already a knowledge base`);
    }

    // In place: the folder must be a direct child of knowledge/, because the id has to equal the
    // directory name (§17.1). Anything deeper is linked instead.
    const depth = cleaned.split("/").filter(Boolean).length;
    const inPlace = inKnowledge && depth === 2 && name === baseId;

    const target = inPlace
      ? path.join(this.workspace, cleaned)
      : path.resolve(this.workspace, cleaned);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new Error(`no such folder in the workspace: ${folder}`);
    }
    // A folder deeper inside knowledge/ is linked like any other, which is how a documentation
    // tree gets split into the parts a project needs (KB-10). Only a base directory is refused,
    // and `resolveSource` does that.

    const { id: _id, ...rest } = patch;
    const manifest = await this.putManifest(baseId, {
      ...rest,
      ...(inPlace ? {} : { source: cleaned }),
    });

    // Whether the base ends up with an index — one it already had, or the stub `putManifest`
    // seeds when there was none. It never has two: `putManifest` looks case-insensitively.
    const hasIndex = (await findIndexFile(inPlace ? target : this.dir(baseId))) !== undefined;
    return { manifest, inPlace, hasIndex };
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
