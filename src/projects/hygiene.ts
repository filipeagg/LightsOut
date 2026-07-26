/**
 * Scratch directory and end-of-run hygiene (PE-08, DESIGN §5.2b).
 *
 * An agent that may run its own tooling (PE-07) produces temporary files. It gets one place to
 * put them — `<project>/.lightsout/tmp/` — which is writable under every policy pack and emptied
 * when the run ends. Anything it leaves untracked elsewhere is reported and never deleted: a
 * leftover and a file created on purpose are indistinguishable from here, and tidying away real
 * work is the worse mistake.
 */
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { scratchRoot, SCRATCH_REL } from "../policy/classify.js";
import { ProjectGit } from "./git.js";

export { SCRATCH_REL, scratchRoot };

/** The directory that holds the scratch directory; ignored by git in full. */
export const SCRATCH_PARENT_REL = ".lightsout";

export type SweepResult = {
  /** Entries removed from the scratch directory. */
  files: number;
  bytes: number;
  /** Untracked paths the run left outside the scratch directory (relative to the project). */
  untracked: string[];
  /** Set when the sweep itself failed; the run is never lost over housekeeping. */
  error?: string;
};

/**
 * Create the scratch directory and the `.gitignore` that hides it. Called at scaffold time and
 * again before every run, because a project can be older than this feature.
 */
export async function ensureScratch(projectPath: string): Promise<string> {
  const root = scratchRoot(projectPath);
  await mkdir(root, { recursive: true });
  const ignore = path.join(projectPath, SCRATCH_PARENT_REL, ".gitignore");
  // The directory ignores itself, so no project .gitignore has to know about it.
  await writeFile(ignore, "# LightsOut scratch space (PE-08); never committed.\n*\n", "utf8");
  return root;
}

async function sizeOf(target: string): Promise<{ files: number; bytes: number }> {
  const info = await stat(target);
  if (!info.isDirectory()) return { files: 1, bytes: info.size };
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(target)) {
    const nested = await sizeOf(path.join(target, entry));
    files += nested.files;
    bytes += nested.bytes;
  }
  return { files, bytes };
}

/**
 * Empty the scratch directory and report what the run left untracked elsewhere. Never throws:
 * a failure to clean is a result field, not an exception, so a finished task cannot be lost to
 * housekeeping.
 */
export async function sweep(projectPath: string): Promise<SweepResult> {
  const result: SweepResult = { files: 0, bytes: 0, untracked: [] };
  const root = scratchRoot(projectPath);

  // Defence in depth: this function deletes, so it refuses to act on anything that is not the
  // scratch directory of the project it was given.
  if (path.relative(projectPath, root) !== SCRATCH_REL) {
    return { ...result, error: `refusing to sweep ${root}: not the scratch directory` };
  }

  try {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === ".gitignore") continue;
      const target = path.join(root, entry);
      const measured = await sizeOf(target).catch(() => ({ files: 1, bytes: 0 }));
      await rm(target, { recursive: true, force: true });
      result.files += measured.files;
      result.bytes += measured.bytes;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  try {
    const git = new ProjectGit(projectPath);
    if (await git.isRepo()) {
      const untracked = await git.untracked();
      result.untracked = untracked
        .filter((file) => !file.startsWith(`${SCRATCH_PARENT_REL}/`))
        .slice(0, 50);
    }
  } catch {
    // Reporting is best effort: the consolidated commit makes leftovers visible anyway.
  }

  return result;
}
