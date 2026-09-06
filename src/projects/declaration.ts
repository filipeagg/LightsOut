/**
 * The project's declaration of itself (PM-13, DESIGN §9.7.1).
 *
 * `lightsout.yaml` described how a project is *run* — the verify gate, the push policy, an inline
 * policy pack — and nothing about what it *is*. So a colleague could clone the repository in full
 * and still not have the project: no brief (PM-09), no phases, no areas, no statement of which
 * knowledge bases it needs. The missing half is written here, by the system, from the database.
 *
 * Two properties this file has to keep, and both are about trust rather than convenience:
 *
 * - **Nothing the user wrote is lost.** The file is merged, not regenerated: the managed keys are
 *   replaced and every other key — an inline `policy:` block above all — is carried through
 *   untouched. A system that rewrites a user's file wholesale is a system people stop editing.
 * - **No value, ever.** `requires.vault` holds entry ids. The field names live in the bundle
 *   (§9.7.3), which is handed to a person deliberately; this file is pushed to a remote (NF-02).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { writeFileDurable } from "../workspace/durable.js";
import {
  CONFIG_FILE,
  type AreaDeclaration,
  type PhaseDeclaration,
} from "./config.js";
import type { ProjectPhaseRow, ProjectRow } from "../db/types.js";
import type { ProjectAreaRow } from "../db/repos/areas.js";

const HEADER = [
  "# LightsOut project declaration (PM-13).",
  "#",
  "# The system writes the keys below from its own state; anything else in this file is yours and",
  "# is preserved. This file travels with the repository, so no credential value belongs in it:",
  "# `requires.vault` names entries, and the names of their fields live in the project bundle.",
  "",
].join("\n");

export type ProjectDeclaration = {
  name: string;
  verify: string;
  push: string;
  remote: string;
  context: string;
  template?: string;
  template_reason?: string;
  phases: PhaseDeclaration[];
  areas: AreaDeclaration[];
  requires: { knowledge: string[]; vault: string[] };
};

/** The order the keys are written in; also the order §9.7.1 documents them in. */
const MANAGED_KEYS = [
  "name",
  "verify",
  "push",
  "remote",
  "context",
  "template",
  "template_reason",
  "phases",
  "areas",
  "requires",
] as const;

export function phaseDeclarationFrom(row: ProjectPhaseRow): PhaseDeclaration {
  return {
    id: row.phase_id,
    title: row.title,
    agent: row.agent_id,
    instructions: row.instructions,
    ...(row.deliverable ? { deliverable: row.deliverable } : {}),
    ...(row.verify_cmd ? { verify: row.verify_cmd } : {}),
    gate: row.gate,
    optional: row.optional === 1,
    repeatable: row.repeatable === 1,
  };
}

export function areaDeclarationFrom(row: ProjectAreaRow): AreaDeclaration {
  return {
    path: row.path,
    access: row.access,
    ...(row.note ? { note: row.note } : {}),
  };
}

/**
 * Build the declaration from what the database says right now.
 *
 * `status` on a phase is deliberately absent: it is the history of one machine's runs, and a
 * second machine adopting the project starts its phases pending (PM-12).
 */
export function buildDeclaration(input: {
  project: ProjectRow;
  phases: ProjectPhaseRow[];
  areas: ProjectAreaRow[];
  knowledge: string[];
  vault: string[];
}): ProjectDeclaration {
  const { project } = input;
  return {
    name: project.name,
    verify: project.verify_cmd ?? "",
    push: project.push_policy,
    remote: project.repo_remote ?? "",
    context: project.context,
    ...(project.template_id ? { template: project.template_id } : {}),
    ...(project.template_reason ? { template_reason: project.template_reason } : {}),
    phases: [...input.phases]
      .sort((a, b) => a.position - b.position)
      .map(phaseDeclarationFrom),
    areas: [...input.areas]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(areaDeclarationFrom),
    requires: {
      knowledge: [...new Set(input.knowledge)].sort(),
      vault: [...new Set(input.vault)].sort(),
    },
  };
}

/** Render the declaration, merged over whatever the file already holds. */
export function renderDeclaration(
  declaration: ProjectDeclaration,
  existing: unknown,
): string {
  const kept: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const key of MANAGED_KEYS) delete kept[key];

  const managed: Record<string, unknown> = {};
  for (const key of MANAGED_KEYS) {
    const value = (declaration as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // An empty list or an empty string is written anyway when it is one of the four keys that
    // have always been there: their absence used to mean "default", and changing that now would
    // change how an old file reads. The rest are omitted when empty, so the file stays readable.
    const alwaysWritten = key === "name" || key === "verify" || key === "push" || key === "remote";
    if (!alwaysWritten) {
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      if (
        key === "requires" &&
        typeof value === "object" &&
        value !== null &&
        Object.values(value as Record<string, string[]>).every((list) => list.length === 0)
      ) {
        continue;
      }
    }
    managed[key] = value;
  }

  const body = dumpYaml({ ...managed, ...kept }, { lineWidth: 100, noRefs: true, sortKeys: false });
  return `${HEADER}${body}`;
}

/**
 * Write the declaration into the project directory, keeping everything the system does not own.
 *
 * Durable (§11.2b): the brief a person typed once must not be lost to an abnormal container exit,
 * which is the same reason the vault writes this way.
 */
export async function writeDeclaration(
  projectPath: string,
  declaration: ProjectDeclaration,
): Promise<void> {
  const file = path.join(projectPath, CONFIG_FILE);
  let existing: unknown;
  try {
    existing = loadYaml(await readFile(file, "utf8"));
  } catch {
    existing = undefined;
  }
  await writeFileDurable(file, renderDeclaration(declaration, existing));
}
