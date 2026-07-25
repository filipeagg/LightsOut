/**
 * Workspace layout (RT-02, DESIGN §2 and §11.1 step 4).
 *
 * The workspace is a folder on the user's own machine bind-mounted at /workspace. Boot makes
 * sure the directories the loaders read from exist, and that a `.gitignore` keeps `vault.yaml`
 * out of any repository the user creates around the workspace (VT-01). Nothing is copied in:
 * the builtin library is usable where it ships (BA-01).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Directories the loaders and the scaffolder read from, relative to the workspace root. */
export const WORKSPACE_DIRS = [
  "agents",
  path.join("agents", "policies"),
  path.join("agents", "fragments"),
  "templates",
  "knowledge",
  "projects",
] as const;

/** Entries the workspace `.gitignore` must contain; `vault.yaml` is the one that matters (VT-01). */
export const WORKSPACE_GITIGNORE_ENTRIES = ["vault.yaml", "vault.yaml.bak"] as const;

const GITIGNORE_HEADER = "# Managed by LightsOut: credentials never belong in a repository.";

export type LayoutReport = {
  root: string;
  /** Directories that did not exist and were created. */
  created: string[];
  /** True when the workspace `.gitignore` was created or amended. */
  gitignoreUpdated: boolean;
};

async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch {
    current = "";
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = WORKSPACE_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return false;
  const prefix = current.length === 0 ? `${GITIGNORE_HEADER}\n` : current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(file, `${prefix}${missing.join("\n")}\n`, "utf8");
  return true;
}

/** Idempotent: safe to run on every boot, reports only what it actually changed. */
export async function ensureWorkspaceLayout(root: string): Promise<LayoutReport> {
  const created: string[] = [];
  await mkdir(root, { recursive: true });
  for (const dir of WORKSPACE_DIRS) {
    const target = path.join(root, dir);
    const made = await mkdir(target, { recursive: true });
    // mkdir resolves to the first directory created, or undefined when it already existed.
    if (made !== undefined) created.push(dir);
  }
  const gitignoreUpdated = await ensureGitignore(root);
  return { root, created, gitignoreUpdated };
}
