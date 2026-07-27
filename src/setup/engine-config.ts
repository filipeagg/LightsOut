/**
 * The engine's own sandbox must not be a second, unconfigured policy engine (ST-09, DESIGN §7.8).
 *
 * The failure this exists for: `contract-prober` could not write a single file, for a whole
 * evening, and the audit trail for the run held **one** permission row. Codex was starting with
 * its own defaults —
 *
 *     approval: never
 *     sandbox:  read-only
 *
 * — so every write failed inside the engine, before ACP, and LightsOut was never asked. The agent
 * reported "the write was denied", which read in the timeline exactly like a policy refusal and
 * sent two rounds of investigation into the classifier, where nothing was wrong.
 *
 * Two sandboxes is one too many. LightsOut mediates every action (PE-01..05) and the container is
 * the boundary (RT-01), so the engine's own confinement is set to `workspace-write` — writes in
 * the working directory, nothing outside it, network on, and every one of them still announced
 * over ACP where the policy engine decides. Defence in depth, not a second veto nobody can see.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Marks the block as ours, so a hand-written config is left alone. */
export const MANAGED_MARKER = "# managed by LightsOut (ST-09)";

export const MANAGED_CODEX_CONFIG = [
  MANAGED_MARKER,
  "# LightsOut mediates every action over ACP and the container is the boundary, so the engine's",
  "# own sandbox is set to allow the work and left to report it, not to refuse it silently.",
  "# Delete this file to go back to the engine's defaults; it is rewritten only when absent.",
  'sandbox_mode = "workspace-write"',
  "",
  "[sandbox_workspace_write]",
  "network_access = true",
  "",
].join("\n");

export type EngineConfigResult = {
  path: string;
  /** written | kept (a user's own file) | unchanged (ours, already correct) */
  action: "written" | "kept" | "unchanged";
  reason: string;
};

/**
 * Ensure the codex home holds a config that lets the engine do the work it is asked for.
 *
 * Never overwrites a file somebody else wrote: a config without our marker is theirs, and the
 * only thing that happens is a warning saying what LightsOut expects and why.
 */
export async function ensureCodexConfig(codexHome: string): Promise<EngineConfigResult> {
  const file = path.join(codexHome, "config.toml");
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    await mkdir(codexHome, { recursive: true });
    await writeFile(file, MANAGED_CODEX_CONFIG, "utf8");
    return {
      path: file,
      action: "written",
      reason: "no config.toml: the engine would have started read-only and never asked",
    };
  }

  if (!existing.includes(MANAGED_MARKER)) {
    const confined = /sandbox_mode\s*=\s*"(read-only|none)"/.exec(existing);
    return {
      path: file,
      action: "kept",
      reason: confined
        ? `left alone (not written by LightsOut), but sandbox_mode is ${confined[1]}: ` +
          `the engine will refuse its own writes before the policy engine is consulted`
        : "left alone: not written by LightsOut",
    };
  }

  if (existing.trim() === MANAGED_CODEX_CONFIG.trim()) {
    return { path: file, action: "unchanged", reason: "already what this version writes" };
  }

  await writeFile(file, MANAGED_CODEX_CONFIG, "utf8");
  return { path: file, action: "written", reason: "ours, and out of date" };
}
