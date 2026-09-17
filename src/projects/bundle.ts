/**
 * The project bundle (PM-14, KB-14, VT-09, DESIGN §9.7.3).
 *
 * A project's repository can be cloned; what it cannot carry is everything the project depends on
 * that lives *outside* it — the knowledge bases in `knowledge/`, the agent profiles in `agents/`,
 * the template in `templates/`, and the fact that three named credentials have to exist before a
 * run works. Without those, an adopted project is a directory that stops at the first launch.
 *
 * So the bundle holds exactly that and nothing else. **No file of the project is in it**: not
 * `src/`, not `doc/`, not even `lightsout.yaml` as a file — only its text inside the manifest, for
 * a machine that has no clone yet. That is what makes it safe to hand around: an archive that
 * cannot contain the code cannot be a stale copy of it.
 *
 * One exception, and it is the case the rule was never about (PM-14 amended, §9.7.3): a project
 * with **no remote**. Git carries nothing there, so "the code comes from git" is advice about a
 * transfer that cannot happen, and what the rule protects against — a second copy drifting from
 * the one git serves — has no first copy to drift from. Then, and only then, the archive holds
 * `project/repo.bundle`: the repository as a `git bundle`, which is history rather than a
 * snapshot, clones into place, and accepts a later bundle as an incremental pull.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { z } from "zod";
import { buildZip, readZip, ZipError, type ZipEntry } from "../http/zip.js";
import { CONFIG_FILE } from "./config.js";
import { ProjectGit } from "./git.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { TemplatesLoader } from "../templates/loader.js";
import type { VaultEntry, VaultEntryView } from "../vault/schema.js";
import type { ProjectRow } from "../db/types.js";

export const BUNDLE_FORMAT = 1;
export const BUNDLE_MANIFEST = "bundle.yaml";
export const BUNDLE_EXTENSION = ".lobundle";

/** The only prefixes an archive may hold, besides the manifest itself. */
const ALLOWED_PREFIXES = ["knowledge/", "agents/", "templates/"] as const;

/**
 * The one entry that may hold the project, and only as a `git bundle` (PM-14 amended).
 *
 * A single fixed name rather than a `project/` prefix on purpose: the exception is *the
 * repository*, not "project files are allowed now". Anything else under `project/` is refused
 * exactly as `src/main.ts` always was.
 */
export const REPO_ENTRY = "project/repo.bundle";

/**
 * A value shorter than this is not scanned for in the leak check.
 *
 * The check exists so that VT-09 is a property of the file rather than a promise about the code
 * that writes it — but a two-character "secret" would match somewhere in every archive and abort
 * exports on coincidence. Eight characters is the length below which a stored value is not a
 * credential in any case, and the check says nothing about the ones above it that it did find.
 */
const MIN_SCANNED_VALUE = 8;

export const bundleKnowledgeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().default("other"),
    /** False when the base's documents belong to a folder this system does not own (KB-14). */
    bundled: z.boolean().default(true),
    documents: z.number().int().nonnegative().default(0),
    sha256: z.string().optional(),
    /** Workspace-relative folder the base reads its documents from, when it has one (KB-08). */
    source: z.string().optional(),
    /**
     * The workspace-relative directories carried for this base, in the archive under exactly
     * these names. Normally one — `knowledge/<id>` — and two when the base reads its documents
     * from elsewhere inside `knowledge/`, because then the manifest and the documents are two
     * trees and `source:` only resolves if both arrive.
     */
    paths: z.array(z.string().min(1)).default([]),
    note: z.string().optional(),
  })
  .strict();

export const bundleVaultSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    auth: z.string().default("none"),
    base_url: z.string().optional(),
    test_only: z.boolean().default(false),
    /** Field **names**. A value here is a defect, and the writer checks (VT-09). */
    fields: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const bundleManifestSchema = z
  .object({
    format: z.number().int(),
    exported: z
      .object({ at: z.string().default(""), lightsout: z.string().default("") })
      .default({ at: "", lightsout: "" }),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().default(""),
        /**
         * How the working copy travels (§9.7.3b). `clone` means the importing side can fetch the
         * code itself from `remote`; `bundle` means the archive carries the repository itself
         * (PM-14 amended); `copy` means somebody has to bring the directory by hand.
         *
         * It exists because `remote: ""` could not say which: a project with no remote and a
         * project whose remote nobody had recorded read identically, and the importer guessed.
         * `copy` is the default so an older bundle, written before this field, is read as the
         * cautious thing rather than as a promise it cannot keep.
         */
        transport: z.enum(["clone", "bundle", "copy"]).default("copy"),
        remote: z.string().default(""),
        /**
         * The repository carried in the archive, present only with `transport: bundle`.
         *
         * `branch` is what the exporting side had checked out, stated so the receiving person can
         * see which line of work arrived without having to go and look.
         */
        repo: z
          .object({
            file: z.string().min(1),
            branch: z.string().default(""),
            bytes: z.number().int().nonnegative().default(0),
            sha256: z.string().default(""),
          })
          .strict()
          .optional(),
        /** `lightsout.yaml` verbatim, so a person can see what they are adopting. */
        declaration: z.string().default(""),
      })
      .strict(),
    requires: z
      .object({
        knowledge: z.array(bundleKnowledgeSchema).default([]),
        agents: z.array(z.string().min(1)).default([]),
        templates: z.array(z.string().min(1)).default([]),
        vault: z.array(bundleVaultSchema).default([]),
      })
      .strict()
      .default({ knowledge: [], agents: [], templates: [], vault: [] }),
  })
  .strict();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export type ExportBundleDeps = {
  workspace: string;
  agents: AgentsLoader;
  knowledge?: KnowledgeLoader;
  templates?: TemplatesLoader;
  /**
   * Every stored entry, values included. They never leave this process: the values are read only
   * so the finished archive can be scanned for them (VT-09).
   */
  vaultEntries?: () => Promise<VaultEntry[]>;
  version: string;
};

export type ExportBundleInput = {
  project: ProjectRow;
  /** Agent ids the project's phases name. */
  agentIds: string[];
  /** Knowledge bases the project needs, by id. */
  knowledgeIds: string[];
  /** Vault entry ids the project depends on (VT-09). */
  vaultIds: string[];
};

export type ExportedBundle = {
  filename: string;
  data: Buffer;
  manifest: BundleManifest;
};

/** A credential value inside an archive is not a warning; it is the export failing. */
export class BundleLeakError extends Error {}

async function readDirRecursive(dir: string, prefix = ""): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await readDirRecursive(abs, rel)));
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out;
}

/** A workspace-relative path with forward slashes, which is how the archive names everything. */
function relativeTo(workspace: string, target: string): string {
  return path.relative(workspace, target).split(path.sep).join("/");
}

function normaliseTree(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** A fingerprint over the sorted file list and its content, so a difference is detectable. */
export function fingerprint(files: { rel: string; data: Buffer }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(file.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The repository as a `git bundle`, for a project no remote can carry (PM-14 amended, §9.7.3).
 *
 * Undefined rather than an error when there is nothing to pack — a directory git has never seen
 * is not a failure of the export, it is a project that travels as `copy` and says so.
 *
 * The leak check here is the honest one, not the reassuring one. `assertNoSecrets` reads bytes,
 * and the bytes of a pack are compressed, so it would pass over a credential without seeing it.
 * The repository is therefore asked directly, with `git grep` at HEAD — and that is **all** it
 * covers: a value committed in March and deleted in April is inside the history this file carries
 * and no check here will find it. Stated in §9.7.3 as a property of the transport rather than
 * left for somebody to discover.
 */
async function packRepository(
  git: ProjectGit,
  projectId: string,
  stored: VaultEntry[],
): Promise<{ data: Buffer; branch: string; bytes: number; sha256: string } | undefined> {
  const scratch = await mkdtemp(path.join(tmpdir(), "lo-repo-"));
  try {
    const file = path.join(scratch, `${projectId}.bundle`);
    const made = await git.createBundle(file).catch(() => undefined);
    if (!made) return undefined;

    for (const entry of stored) {
      for (const [field, value] of Object.entries(entry.fields)) {
        if (value.length < MIN_SCANNED_VALUE) continue;
        const hit = await git.grepHead(value);
        if (hit) {
          throw new BundleLeakError(
            `refusing to export: ${hit} holds the stored value of ${entry.id}.${field}, and this ` +
              "bundle would carry the repository (VT-09). Take it out of the tree, commit, and " +
              "export again",
          );
        }
      }
    }

    const data = await readFile(file);
    return {
      data,
      branch: made.branch,
      bytes: made.bytes,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function exportBundle(
  input: ExportBundleInput,
  deps: ExportBundleDeps,
): Promise<ExportedBundle> {
  const entries: ZipEntry[] = [];
  // Read before anything is packed, because the repository check below needs the values and the
  // final byte scan needs them too. They never leave this process either way (VT-09).
  const stored = deps.vaultEntries ? await deps.vaultEntries() : [];

  // Only when the directory is really there: `simpleGit` refuses a baseDir that does not exist,
  // and a project declared but not yet cloned (§9.7.2b) is exactly that case.
  const git = (await pathExists(input.project.path))
    ? new ProjectGit(input.project.path)
    : undefined;
  // The row knows when somebody told it; the repository knows always (§9.7.1b). Asking here as
  // well as in `syncDeclaration` means an export is correct even on a project whose declaration
  // has not been rewritten since it gained an origin.
  const remote =
    input.project.repo_remote ?? (await git?.getRemote().catch(() => undefined)) ?? "";

  // PM-14 amended: only when git carries nothing, and only as history.
  const packed =
    remote || !git ? undefined : await packRepository(git, input.project.id, stored);
  if (packed) entries.push({ name: REPO_ENTRY, data: packed.data });

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    exported: { at: new Date().toISOString(), lightsout: deps.version },
    project: {
      id: input.project.id,
      name: input.project.name,
      // §9.7.3b: stated, never guessed. The row is consulted first and the repository asked when
      // it says nothing (§9.7.1b), so a project with an origin is never exported as uncopyable —
      // and `copy` is now only what is left when there is neither an origin nor a repository to
      // pack, which is a directory that git has never seen.
      transport: remote ? "clone" : packed ? "bundle" : "copy",
      remote,
      ...(packed
        ? {
            repo: {
              file: REPO_ENTRY,
              branch: packed.branch,
              bytes: packed.bytes,
              sha256: packed.sha256,
            },
          }
        : {}),
      declaration: await readFile(path.join(input.project.path, CONFIG_FILE), "utf8").catch(
        () => "",
      ),
    },
    requires: { knowledge: [], agents: [], templates: [], vault: [] },
  };

  // --- knowledge (KB-14) ---------------------------------------------------------------
  for (const baseId of input.knowledgeIds) {
    const base = deps.knowledge?.get(baseId);
    if (!base) {
      manifest.requires.knowledge.push({
        id: baseId,
        kind: "other",
        bundled: false,
        documents: 0,
        paths: [],
        note: "declared by the project but not installed on the machine that exported it",
      });
      continue;
    }
    // KB-14: what decides this is ownership, not whether the base has a `source`. A base reading
    // `knowledge/acme/technical` is inside the knowledge area and is the system's to carry; one
    // reading `sources/acme-export` is a view over somebody's own tree and is only ever named.
    // The first version of this file used `base.source` for the test, and quietly left eighteen
    // documents of a real base behind on the machine that exported them.
    if (!deps.knowledge?.ownsItsDocuments(baseId)) {
      manifest.requires.knowledge.push({
        id: baseId,
        kind: base.manifest.kind,
        bundled: false,
        documents: base.documents.length,
        ...(base.source ? { source: base.source } : {}),
        paths: [],
        note: base.source
          ? `not bundled: its documents are read from ${base.source}, which is outside knowledge/ and belongs to the workspace`
          : "not bundled: its documents are outside the knowledge area",
      });
      continue;
    }

    // Carried under their own workspace-relative names, so the archive is a slice of the
    // workspace and `source:` resolves on the other machine without being rewritten.
    const trees = [...new Set([relativeTo(deps.workspace, base.dir), ...(base.source ? [normaliseTree(base.source)] : [])])];
    const loaded: { rel: string; data: Buffer }[] = [];
    for (const tree of trees) {
      const files = await readDirRecursive(path.join(deps.workspace, tree));
      for (const file of files) {
        const data = await readFile(file.abs);
        loaded.push({ rel: `${tree}/${file.rel}`, data });
      }
    }
    for (const file of loaded) {
      if (entries.some((entry) => entry.name === file.rel)) continue;
      entries.push({ name: file.rel, data: file.data });
    }
    manifest.requires.knowledge.push({
      id: baseId,
      kind: base.manifest.kind,
      bundled: true,
      documents: base.documents.length,
      ...(base.source ? { source: base.source } : {}),
      paths: trees,
      sha256: fingerprint(loaded),
    });
  }

  // --- agents (AP-06): builtins are on every install; workspace profiles are not ---------
  for (const agentId of [...new Set(input.agentIds)].sort()) {
    const file = path.join(deps.agents.agentsDir, `${agentId}.yaml`);
    const data = await readFile(file).catch(() => undefined);
    if (!data) continue;
    entries.push({ name: `agents/${agentId}.yaml`, data });
    manifest.requires.agents.push(agentId);
  }

  // --- the template it came from, when that is not a builtin either (TP-04) --------------
  const templateId = input.project.template_id;
  if (templateId && deps.templates) {
    const file = path.join(deps.templates.templatesDir, `${templateId}.yaml`);
    const data = await readFile(file).catch(() => undefined);
    if (data) {
      entries.push({ name: `templates/${templateId}.yaml`, data });
      manifest.requires.templates.push(templateId);
    }
  }

  // --- vault: names, and the check that it is only names (VT-09) -------------------------
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  for (const entryId of input.vaultIds) {
    const entry = byId.get(entryId);
    if (!entry) {
      manifest.requires.vault.push({ id: entryId, label: entryId, auth: "none", test_only: false, fields: [] });
      continue;
    }
    manifest.requires.vault.push({
      id: entry.id,
      label: entry.label,
      auth: entry.auth,
      ...(entry.base_url ? { base_url: entry.base_url } : {}),
      test_only: entry.test_only,
      fields: Object.keys(entry.fields).sort(),
    });
  }

  entries.unshift({
    name: BUNDLE_MANIFEST,
    data: Buffer.from(dumpYaml(manifest, { lineWidth: 100, noRefs: true, sortKeys: false }), "utf8"),
  });

  assertNoSecrets(entries, stored);

  return {
    filename: `${input.project.id}${BUNDLE_EXTENSION}`,
    data: buildZip(entries),
    manifest,
  };
}

/**
 * Refuse to hand over an archive that contains a stored credential (VT-09).
 *
 * Checked over the entries rather than argued about in a comment: every path that puts bytes in
 * this archive passes through here, so a future one that reads the wrong thing fails loudly at
 * the moment of export instead of quietly at the moment of sharing.
 */
export function assertNoSecrets(entries: ZipEntry[], stored: VaultEntry[]): void {
  const values = stored
    .flatMap((entry) =>
      Object.entries(entry.fields).map(([field, value]) => ({ entry: entry.id, field, value })),
    )
    .filter((held) => held.value.length >= MIN_SCANNED_VALUE);
  if (values.length === 0) return;

  for (const entry of entries) {
    for (const held of values) {
      if (entry.data.includes(held.value)) {
        throw new BundleLeakError(
          `refusing to export: ${entry.name} contains the stored value of ` +
            `${held.entry}.${held.field}. A bundle names credentials and never holds one (VT-09)`,
        );
      }
    }
  }
}

// --- import ------------------------------------------------------------------------------

export type ImportBundleDeps = {
  workspace: string;
  /** Where working copies live. Defaults to `<workspace>/projects`, which is where they do. */
  projectsDir?: string;
  agents: AgentsLoader;
  knowledge?: KnowledgeLoader;
  templates?: TemplatesLoader;
  /** Create a vault entry with empty fields; never called for an entry that already exists. */
  createVaultEntry?: (entry: {
    id: string;
    label: string;
    auth: string;
    base_url?: string;
    test_only: boolean;
    scope: string[];
    fields: string[];
  }) => Promise<void>;
  vaultViews?: () => Promise<VaultEntryView[]>;
};

export type ImportedGroup = {
  written: string[];
  /** Already installed here, so the archive did not touch it. `differs` when the content is not the same. */
  skipped: { id: string; differs: boolean }[];
  /** Named by the bundle but not carried in it: a linked base, or a base the exporter lacked. */
  declared: { id: string; note: string }[];
};

/** What became of the repository the archive carried, when it carried one (PM-14 amended). */
export type ImportedRepo = {
  /** True when this import cloned it into `projects/<id>`. */
  restored: boolean;
  path: string;
  branch?: string;
  /** Why not, when `restored` is false. Never a silence: a repository that arrived and was not
   * unpacked is exactly the situation the caller has to be told about. */
  note?: string;
};

export type ImportBundleResult = {
  manifest: BundleManifest;
  /** Absent when the archive carried no repository, which is the ordinary case. */
  repo?: ImportedRepo;
  knowledge: ImportedGroup;
  agents: ImportedGroup;
  templates: ImportedGroup;
  vault: { created: string[]; existing: string[] };
};

/** Parse and validate an archive without writing anything. */
export function openBundle(data: Buffer): { manifest: BundleManifest; files: Map<string, Buffer> } {
  const entries = readZip(data);
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, "/");
    if (name === BUNDLE_MANIFEST) {
      files.set(name, entry.data);
      continue;
    }
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")) {
      throw new ZipError(`refusing an archive entry that escapes it: ${entry.name}`);
    }
    if (name !== REPO_ENTRY && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new ZipError(
        `refusing ${entry.name}: a bundle holds the manifest, knowledge/, agents/, templates/ ` +
          `and — only for a project with no remote — ${REPO_ENTRY}; nothing of the project ` +
          "itself (PM-14)",
      );
    }
    files.set(name, entry.data);
  }

  const raw = files.get(BUNDLE_MANIFEST);
  if (!raw) throw new ZipError(`not a project bundle: no ${BUNDLE_MANIFEST}`);
  const manifest = bundleManifestSchema.parse(loadYaml(raw.toString("utf8")));
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new ZipError(
      `bundle format ${manifest.format} is not the ${BUNDLE_FORMAT} this install reads; ` +
        "export it again from a matching version",
    );
  }
  return { manifest, files };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone the carried repository into `projects/<id>` (PM-14 amended, §9.7.3).
 *
 * The same refusal that governs every other kind of entry governs this one: **an import never
 * overwrites what the receiving machine already has.** A directory with anything in it is left
 * exactly as it was and reported, because a half-finished working copy is somebody's work and an
 * archive has no business deciding it was the wrong version.
 *
 * A failure here is reported rather than thrown. The rest of the import — knowledge, agents,
 * vault — is worth having even when the clone did not happen, and `next` says what is left.
 */
async function restoreRepository(
  manifest: BundleManifest,
  files: Map<string, Buffer>,
  deps: ImportBundleDeps,
): Promise<ImportedRepo | undefined> {
  const carried = files.get(REPO_ENTRY);
  if (!carried) return undefined;

  const projectsDir = deps.projectsDir ?? path.join(deps.workspace, "projects");
  const target = path.join(projectsDir, manifest.project.id);
  const present = await readdir(target).catch(() => [] as string[]);
  if (present.length > 0) {
    return {
      restored: false,
      path: target,
      note:
        "a working copy is already there, so the repository in the bundle was not unpacked and " +
        "nothing of yours was touched. `git pull <the bundle file>` inside it applies the " +
        "history instead",
    };
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "lo-repo-"));
  try {
    const file = path.join(scratch, "repo.bundle");
    await writeFile(file, carried);
    await mkdir(projectsDir, { recursive: true });
    // `git clone` refuses a target that exists, and an empty directory left by a previous attempt
    // is exactly the thing it would refuse.
    await rm(target, { recursive: true, force: true });
    await ProjectGit.restoreFromBundle(file, target);
    return {
      restored: true,
      path: target,
      ...(manifest.project.repo?.branch ? { branch: manifest.project.repo.branch } : {}),
    };
  } catch (err) {
    return {
      restored: false,
      path: target,
      note: `the repository in the bundle could not be unpacked: ${(err as Error).message}`,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function importBundle(
  data: Buffer,
  deps: ImportBundleDeps,
): Promise<ImportBundleResult> {
  const { manifest, files } = openBundle(data);

  // First, because everything after it is a dependency *of* the working copy, and because
  // adoption downstream asks whether the directory is there.
  const repo = await restoreRepository(manifest, files, deps);

  const knowledge: ImportedGroup = { written: [], skipped: [], declared: [] };
  for (const required of manifest.requires.knowledge) {
    if (!required.bundled) {
      knowledge.declared.push({
        id: required.id,
        note: required.note ?? `not carried by the bundle${required.source ? `; reads ${required.source}` : ""}`,
      });
      continue;
    }
    // Older bundles named no trees; one base, one directory, is what they meant.
    const trees = required.paths.length > 0 ? required.paths : [`knowledge/${required.id}`];
    const carried = [...files.entries()].filter(([name]) =>
      trees.some((tree) => name.startsWith(`${tree}/`)),
    );
    if (carried.length === 0) {
      knowledge.declared.push({ id: required.id, note: "the manifest names it but the archive does not carry it" });
      continue;
    }

    // KB-14: an existing base is never overwritten by an archive. Saying whether it differs is
    // the difference between "nothing to do" and "you two have diverged".
    const present: { rel: string; data: Buffer }[] = [];
    let anyPresent = false;
    for (const tree of trees) {
      const dir = path.join(deps.workspace, tree);
      if (!(await pathExists(dir))) continue;
      anyPresent = true;
      for (const file of await readDirRecursive(dir)) {
        present.push({ rel: `${tree}/${file.rel}`, data: await readFile(file.abs) });
      }
    }
    if (anyPresent) {
      const differs = required.sha256 !== undefined && fingerprint(present) !== required.sha256;
      knowledge.skipped.push({ id: required.id, differs });
      continue;
    }

    for (const [name, content] of carried) {
      const target = path.join(deps.workspace, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    knowledge.written.push(required.id);
  }

  const agents: ImportedGroup = { written: [], skipped: [], declared: [] };
  for (const agentId of manifest.requires.agents) {
    const carried = files.get(`agents/${agentId}.yaml`);
    if (!carried) {
      agents.declared.push({ id: agentId, note: "named by the manifest but not carried" });
      continue;
    }
    const target = path.join(deps.agents.agentsDir, `${agentId}.yaml`);
    if (await pathExists(target)) {
      const current = await readFile(target);
      agents.skipped.push({ id: agentId, differs: !current.equals(carried) });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, carried);
    agents.written.push(agentId);
  }

  const templates: ImportedGroup = { written: [], skipped: [], declared: [] };
  for (const templateId of manifest.requires.templates) {
    const carried = files.get(`templates/${templateId}.yaml`);
    if (!carried || !deps.templates) {
      templates.declared.push({ id: templateId, note: "named by the manifest but not carried" });
      continue;
    }
    const target = path.join(deps.templates.templatesDir, `${templateId}.yaml`);
    if (await pathExists(target)) {
      const current = await readFile(target);
      templates.skipped.push({ id: templateId, differs: !current.equals(carried) });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, carried);
    templates.written.push(templateId);
  }

  // The loaders are the only thing that makes a written file a base, a profile or a template.
  await deps.knowledge?.load();
  await deps.agents.load();
  await deps.templates?.load();

  // --- vault: create the named entries with their fields empty (VT-09) -------------------
  const vault = { created: [] as string[], existing: [] as string[] };
  const views = deps.vaultViews ? await deps.vaultViews() : [];
  const known = new Set(views.map((view) => view.id));
  for (const required of manifest.requires.vault) {
    if (known.has(required.id)) {
      // An entry that exists is never touched: a field with a value in it is somebody's
      // credential, and an import has no business deciding it was the wrong one.
      vault.existing.push(required.id);
      continue;
    }
    if (!deps.createVaultEntry) continue;
    await deps.createVaultEntry({
      id: required.id,
      label: required.label,
      auth: required.auth,
      ...(required.base_url ? { base_url: required.base_url } : {}),
      test_only: required.test_only,
      scope: [manifest.project.id],
      fields: required.fields,
    });
    vault.created.push(required.id);
  }

  return { manifest, ...(repo ? { repo } : {}), knowledge, agents, templates, vault };
}
