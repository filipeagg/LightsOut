/**
 * Reading a project's documents (PM-10, DESIGN §9.4).
 *
 * The deliverables are what a run produces, and until now the only way to read one was the
 * filesystem: `read_doc` knew four managed names and nothing else. This module lists every
 * Markdown file a project holds and returns the content of one, with the confinement checked
 * rather than assumed.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { lintDocument, type DocumentLint } from "./deliverable.js";

/** Never walked: the imported source of a system, git internals, dependencies, scratch space. */
export const SKIP_DIRS = new Set(["sources", ".git", "node_modules", ".lightsout"]);
export const MAX_DEPTH = 6;
export const MAX_FILES = 300;
/** Content above this is returned truncated, and says so (§9.4). */
export const MAX_BYTES = 400_000;

/** The four documents the system itself maintains (PM-02). */
export const MANAGED = new Set([
  "doc/STATE.md",
  "doc/PLAN.md",
  "doc/DECISIONS.md",
  "doc/QUESTIONS.md",
]);

export type DocEntry = {
  /** Project-relative, always with forward slashes so both surfaces agree. */
  path: string;
  bytes: number;
  modified: string;
  managed: boolean;
  /** BA-08 verdict, so drift is visible in the list and not only in an event. */
  lint: { ok: boolean; exempt: boolean; reasons: string[] };
};

function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** Every Markdown file in the project, bounded and with the noisy directories skipped. */
export async function listProjectDocs(projectPath: string): Promise<DocEntry[]> {
  const found: DocEntry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Alphabetical, files before directories, so the listing is stable between calls.
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (found.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() || !isMarkdown(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(projectPath, absolute).split(path.sep).join("/");
      try {
        const info = await stat(absolute);
        const lint = lintDocument(await readFile(absolute, "utf8"));
        found.push({
          path: relative,
          bytes: info.size,
          modified: info.mtime.toISOString(),
          managed: MANAGED.has(relative),
          lint: { ok: lint.ok, exempt: lint.exempt, reasons: lint.reasons },
        });
      } catch {
        continue; // vanished between readdir and stat: not worth failing the listing
      }
    }
  };

  await walk(projectPath, 0);
  return found;
}

/**
 * Resolve a project-relative document path, refusing anything that is not ours to read: an
 * absolute path, an escape, a non-Markdown file, or a file inside a skipped directory. Returns
 * the absolute path.
 */
export function resolveDocPath(projectPath: string, relative: string): string {
  const value = relative.trim().replace(/\\/g, "/");
  if (!value) throw new Error("give a path relative to the project");
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`path must be relative to the project: ${relative}`);
  }
  if (!isMarkdown(value)) throw new Error(`only Markdown documents are readable: ${relative}`);

  const root = path.resolve(projectPath);
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the project: ${relative}`);
  }
  const segments = path.relative(root, target).split(path.sep);
  if (segments.some((segment) => SKIP_DIRS.has(segment))) {
    throw new Error(`this directory is not served: ${relative}`);
  }
  return target;
}

export type DocContent = {
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
  lint: DocumentLint;
};

export async function readProjectDoc(
  projectPath: string,
  relative: string,
): Promise<DocContent> {
  const target = resolveDocPath(projectPath, relative);
  const info = await stat(target);
  const whole = await readFile(target, "utf8");
  const truncated = info.size > MAX_BYTES;
  return {
    path: path.relative(projectPath, target).split(path.sep).join("/"),
    bytes: info.size,
    truncated,
    content: truncated ? whole.slice(0, MAX_BYTES) : whole,
    lint: lintDocument(whole),
  };
}

/**
 * The same file as the user sees it on their own machine (PM-10). Null when the host workspace is
 * unknown: a guessed path is worse than no path.
 */
export function hostPathFor(
  workspace: string,
  workspaceHost: string,
  absolute: string,
): string | null {
  if (!workspaceHost) return null;
  const inside = path.relative(path.resolve(workspace), path.resolve(absolute));
  if (inside.startsWith("..")) return null;
  const separator = workspaceHost.includes("\\") ? "\\" : "/";
  const tail = inside.split(path.sep).join(separator);
  return `${workspaceHost.replace(/[\\/]+$/, "")}${separator}${tail}`;
}
