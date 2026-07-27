/**
 * The ten seconds of regret git cannot cover (MC-12, DESIGN §9.2b).
 *
 * `write_doc` replaces a file. That is what it is for, and it is also how eight recorded decisions
 * stopped existing: the caller meant to add one entry, no run was active so nothing refused it, and
 * the last commit predated every one of them. Git protects what was committed; doc writes happen
 * between commits, and the window between them is exactly where the damage lives.
 *
 * So before any overwrite the current bytes are copied aside. Not version control — no diffing, no
 * restore command, no history browsing. A file, with a timestamp, in a directory that is already
 * git-ignored and is not touched by the PE-08 sweep (which empties `.lightsout/tmp` and nothing
 * else). Ten of them, then the oldest goes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "../workspace/durable.js";

/** Inside `.lightsout/`, whose own `.gitignore` is `*` (§PE-08). */
export const DOC_HISTORY_REL = path.join(".lightsout", "doc-history");

/** Per document, per base. Enough to undo a mistake; not enough to become a filesystem problem. */
export const HISTORY_KEEP = 10;

/** The version identifier a caller passes back as `baseHash` (MC-14). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Filename-safe and sortable, which is the whole requirement. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Keep the newest `HISTORY_KEEP` snapshots of one document and drop the rest. Names sort
 * lexicographically in timestamp order, so no `stat` call is needed to know which is oldest.
 */
async function prune(dir: string, prefix: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const mine = entries.filter((name) => name.startsWith(`${prefix}-`)).sort();
  for (const name of mine.slice(0, Math.max(0, mine.length - HISTORY_KEEP))) {
    await unlink(path.join(dir, name)).catch(() => undefined);
  }
}

/**
 * Copy a file aside before it is overwritten. Returns the snapshot's path, or null when there was
 * nothing to save — a first write destroys nothing.
 *
 * Never throws: housekeeping that can fail a write it was meant to protect is worse than no
 * housekeeping. A failure to snapshot is reported as "no snapshot", and the write proceeds.
 */
export async function snapshotFile(
  file: string,
  historyDir: string,
  name: string,
): Promise<string | null> {
  let current: string;
  try {
    current = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    await mkdir(historyDir, { recursive: true });
    const target = path.join(historyDir, `${name}-${stamp()}.md`);
    await writeFileDurable(target, current);
    await prune(historyDir, name);
    return target;
  } catch {
    return null;
  }
}

/** The project's doc history directory. */
export function docHistoryDir(projectPath: string): string {
  return path.join(projectPath, DOC_HISTORY_REL);
}

/**
 * Knowledge documents keep their history in the workspace, not in the base's own folder: a linked
 * base points at a directory that belongs to the user (KB-08), and LightsOut does not leave its
 * bookkeeping in someone else's folder.
 */
export function knowledgeHistoryDir(workspace: string, baseId: string): string {
  return path.join(workspace, ".lightsout", "knowledge-history", baseId);
}
