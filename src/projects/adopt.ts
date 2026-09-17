/**
 * Adopting a project that already exists (PM-12, DESIGN §9.7.2).
 *
 * A colleague with LightsOut installed and push access to the remote does not need a copy of this
 * machine's database — he needs his own install to *see* a directory that is already there. Most
 * of a project is a git repository and git is how it travels; what the repository cannot carry is
 * the row that makes the system aware of it, and `lightsout.yaml` (PM-13) holds everything that
 * row needs.
 *
 * The rule that shapes every decision in this file: adoption is a **read** of somebody's
 * repository. It creates no source file, rewrites no `lightsout.yaml` and makes no commit. The one
 * thing it creates is `.lightsout/tmp/` with its self-ignoring `.gitignore`, which is scratch the
 * runner requires and git already ignores (PE-08).
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Repos } from "../db/repos/index.js";
import type { ProjectRow, PushPolicy } from "../db/types.js";
import { slugify } from "../ids.js";
import { ProjectGit } from "./git.js";
import { ensureScratch } from "./hygiene.js";
import { ensureToolchain } from "./toolchain.js";
import { load as loadYaml } from "js-yaml";
import {
  CONFIG_FILE,
  projectConfigSchema,
  readProjectConfig,
  type ProjectConfig,
} from "./config.js";
import { validateArea } from "./areas.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { VaultEntryView } from "../vault/schema.js";

export type AdoptProjectInput = {
  /** The directory name under `projects/`, and the project id. */
  id: string;
  /** Clone this first. Refused when the directory already exists and is not empty. */
  remote?: string;
  /**
   * `lightsout.yaml` as text, for declaring a project whose working copy has not arrived yet
   * (§9.7.2b). The bundle carries exactly this in `manifest.project.declaration`. Ignored when
   * the directory is there, because then the file on disk is the declaration.
   */
  declaration?: string;
};

/**
 * What the project needs that this machine does not have yet.
 *
 * Adoption succeeds with a non-empty `missing`: the project is real and readable, and knowing
 * what is absent is more useful before a launch than during one. PE-12 already refuses a task
 * whose preconditions are unmet; this turns that refusal into a list.
 */
export type AdoptMissing = {
  /** Bases named in `requires.knowledge` that are not installed here (KB-14). */
  knowledge: string[];
  /** Agent profiles the phases name that neither the workspace nor the builtins hold (AP-07). */
  agents: string[];
  /** Vault entries that are absent, or present with every field empty (VT-09). */
  vault: string[];
  /** Areas whose directory does not exist here, so the declaration could not be applied (PE-09). */
  areas: string[];
  /**
   * The working copy itself, when it is not here (§9.7.2b): the path that has to arrive, or null.
   *
   * The odd one out on purpose. Every other kind of absence is reported and worked around — a run
   * can start without a market base or an unfilled vault entry and fail its own way. This one
   * refuses the launch, because there is no directory to run in and discovering that inside a run
   * means an adapter dying on a `cwd` that does not exist.
   */
  workdir: string | null;
};

export type AdoptProjectResult = {
  project: ProjectRow;
  /** False when the project was already known: adoption is idempotent. */
  adopted: boolean;
  phases: number;
  knowledge: string[];
  missing: AdoptMissing;
};

export type AdoptProjectDeps = {
  agents?: AgentsLoader;
  knowledge?: KnowledgeLoader;
  /** Vault views: presence of a field, never a value (VT-03). */
  vaultViews?: () => Promise<VaultEntryView[]>;
};

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true; // does not exist
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which vault entries named by the declaration are not usable here (VT-09).
 *
 * "Present but every field empty" counts as missing on purpose: an entry created by an import
 * (§9.7.3) is exactly that, and reporting it as satisfied would defeat the reason it was created.
 */
function missingVault(required: string[], views: VaultEntryView[]): string[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  return required.filter((id) => {
    const view = byId.get(id);
    if (!view) return true;
    return !view.fields.some((field) => field.present);
  });
}

export async function adoptProject(
  repos: Repos,
  workspace: string,
  input: AdoptProjectInput,
  deps: AdoptProjectDeps = {},
): Promise<AdoptProjectResult> {
  const id = slugify(input.id);
  const projectPath = path.join(workspace, "projects", id);

  const existing = repos.projects.get(id);
  if (existing) {
    // Idempotent, like `createProject`: the same call twice is a person making sure, not a
    // request to do it again.
    return {
      project: existing,
      adopted: false,
      phases: repos.phases.list(existing.id).length,
      knowledge: repos.projectKnowledge.list(existing.id).map((row) => row.base_id),
      missing: await collectMissing(repos, workspace, existing, deps),
    };
  }

  if (input.remote) {
    if (!(await isEmptyDir(projectPath))) {
      throw new Error(
        `${projectPath} already exists and is not empty; adopt it without a remote, or choose ` +
          "another id. A clone that lands on top of something is not a clone",
      );
    }
    await ProjectGit.clone(input.remote, projectPath);
  }

  /**
   * §9.7.2b: an absent directory stopped being a refusal on its own.
   *
   * With a declaration in hand — the bundle carries `lightsout.yaml` verbatim, and says so — the
   * project is *declared*: the row, its phases and its requirements exist, `missing.workdir` names
   * what has to arrive, and a launch is refused until it does. Without one there is still nothing
   * to adopt, and the refusal below is unchanged.
   */
  const hasWorkdir = !(await isEmptyDir(projectPath));
  if (!hasWorkdir && !input.declaration) {
    throw new Error(
      `no project at projects/${id}. Clone it there first, pass its remote to adopt it in one ` +
        "step, or use create_project to start a new one",
    );
  }

  const config = hasWorkdir
    ? (await readProjectConfig(projectPath)).config
    : projectConfigSchema.parse(loadYaml(input.declaration ?? "") ?? {});
  if (hasWorkdir && !(await exists(path.join(projectPath, CONFIG_FILE)))) {
    throw new Error(
      `projects/${id} holds no ${CONFIG_FILE}, so there is nothing that says what this project ` +
        "is (PM-13). Adoption reads a declaration; use create_project to write one",
    );
  }
  if (!config.context.trim()) {
    throw new Error(
      `${CONFIG_FILE} in projects/${id} has no context brief (PM-09). Add a \`context:\` block ` +
        "saying what the project is for on the machine that owns it, commit it, and pull",
    );
  }

  const project = repos.projects.create({
    id,
    name: config.name?.trim() || id,
    path: projectPath,
    context: config.context.trim(),
    repoRemote: config.remote || input.remote || null,
    pushPolicy: (config.push ?? "manual") as PushPolicy,
    verifyCmd: config.verify || null,
    templateId: config.template ?? null,
    templateReason: config.template_reason ?? null,
    // Only while there is no file to read it from (§9.7.2b). With a working copy the file is the
    // declaration and a second copy on the row could only ever go stale.
    declaration: hasWorkdir ? null : (input.declaration ?? null),
  });

  // The phases come from the file, never from the template. TP-05 freezes a project's phases at
  // creation precisely because the template may move afterwards; re-materialising from whatever
  // the template says today would hand the second machine a quietly different project.
  const phases = materialisePhases(repos, project.id, config);
  if (phases > 0 && !repos.chains.activeForProject(project.id)) {
    repos.chains.create({ projectId: project.id, title: project.name });
  }

  applyAreas(repos, workspace, project, config);
  const attached = attachDeclaredKnowledge(repos, project.id, config, deps.knowledge);

  // Nothing goes into a directory that is still waiting to be cloned into: `git clone` refuses a
  // target that is not empty, and a scratch folder created now would be the thing refusing it.
  if (hasWorkdir) await ensureScratch(projectPath);
  await ensureToolchain(id).catch(() => undefined);

  repos.events.append({
    type: "project.adopted",
    payload: {
      projectId: project.id,
      path: projectPath,
      remote: project.repo_remote,
      phases,
      knowledge: attached,
      cloned: !!input.remote,
      // §9.7.2b: false means the row exists and the working copy does not.
      workdir: hasWorkdir,
    },
  });

  const missing = await collectMissing(repos, workspace, project, deps);
  return { project, adopted: true, phases, knowledge: attached, missing };
}

function materialisePhases(repos: Repos, projectId: string, config: ProjectConfig): number {
  let position = 0;
  for (const phase of config.phases) {
    repos.phases.create({
      projectId,
      position: position++,
      phaseId: phase.id,
      title: phase.title,
      agentId: phase.agent,
      instructions: phase.instructions,
      deliverable: phase.deliverable ?? null,
      verifyCmd: phase.verify ?? null,
      gate: phase.gate,
      optional: phase.optional,
      repeatable: phase.repeatable,
    });
  }
  return position;
}

/**
 * Declare the areas the file names, skipping the ones that cannot be (PE-09).
 *
 * `validateArea` refuses a path that does not exist, and that refusal is right: a typo is caught
 * at declaration rather than silently at run time. On a second machine the directory may simply
 * not be there yet — a customer export nobody copied over — so the area is left undeclared and
 * reported as missing instead of failing the whole adoption.
 */
function applyAreas(
  repos: Repos,
  workspace: string,
  project: ProjectRow,
  config: ProjectConfig,
): void {
  for (const area of config.areas) {
    try {
      const target = validateArea(workspace, project.path, area.path);
      repos.areas.add({
        projectId: project.id,
        path: target.relative,
        access: area.access,
        ...(area.note ? { note: area.note } : {}),
        addedBy: "system",
      });
    } catch {
      // Reported by `collectMissing`, which asks the same question of the same file.
    }
  }
}

function attachDeclaredKnowledge(
  repos: Repos,
  projectId: string,
  config: ProjectConfig,
  knowledge: KnowledgeLoader | undefined,
): string[] {
  const attached: string[] = [];
  for (const baseId of config.requires.knowledge) {
    const base = knowledge?.get(baseId);
    if (!base) continue;
    repos.projectKnowledge.attach({
      projectId,
      baseId: base.manifest.id,
      kind: base.manifest.kind,
      // KB-05: at most one writable base, and which one is a decision of the machine that
      // curates. An adopted project attaches everything read-only and says so by doing nothing.
      writable: false,
    });
    attached.push(base.manifest.id);
  }
  return attached;
}

/**
 * What this machine still lacks for the project to run, computed from the declaration.
 *
 * The file when there is one, and only then the copy kept on the row (§9.7.2b). The order is the
 * whole rule: a project whose clone has landed is described by its own `lightsout.yaml`, and the
 * stand-in is what keeps a project that is still waiting from reporting an empty `requires` —
 * which would read as "nothing left to do" at exactly the moment everything is left to do.
 */
async function collectMissing(
  repos: Repos,
  workspace: string,
  project: ProjectRow,
  deps: AdoptProjectDeps,
): Promise<AdoptMissing> {
  const onDisk = await exists(path.join(project.path, CONFIG_FILE));
  const config =
    onDisk || !project.declaration
      ? (await readProjectConfig(project.path)).config
      : projectConfigSchema.parse(loadYaml(project.declaration) ?? {});
  const workdir = (await isEmptyDir(project.path)) ? project.path : null;
  const knowledge = config.requires.knowledge.filter((id) => !deps.knowledge?.get(id));
  const agents = [
    ...new Set(
      repos.phases
        .list(project.id)
        .map((phase) => phase.agent_id)
        .filter((agentId) => !deps.agents?.profile(agentId)),
    ),
  ];
  const views = deps.vaultViews ? await deps.vaultViews() : [];
  const vault = deps.vaultViews ? missingVault(config.requires.vault, views) : config.requires.vault;
  const areas = config.areas
    .filter((area) => {
      try {
        validateArea(workspace, project.path, area.path);
        return false;
      } catch {
        return true;
      }
    })
    .map((area) => area.path);
  return { knowledge, agents, vault, areas, workdir };
}
