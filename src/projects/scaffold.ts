/**
 * Project scaffolding (PM-01, DESIGN §9.1).
 * Copies `scaffold/`, fills `lightsout.yaml`, initialises git with the scaffold
 * commit, and inserts the project row. Idempotent: an existing project is returned as is.
 */
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Repos } from "../db/repos/index.js";
import type { ProjectRow, PushPolicy } from "../db/types.js";
import { slugify } from "../ids.js";
import { ProjectGit } from "./git.js";
import { ensureScratch } from "./hygiene.js";
import { ensureToolchain } from "./toolchain.js";
import { CONFIG_FILE, readProjectConfig } from "./config.js";
import type { TemplatesLoader } from "../templates/loader.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { PhaseService } from "../orchestrator/phases.js";

export type CreateProjectInput = {
  name: string;
  /**
   * The context brief, required whatever the template (PM-09): what this project is for. Refused
   * when empty, because a project whose agents have to infer their purpose is the failure this
   * exists to prevent. Nothing else about its shape is enforced.
   */
  context: string;
  /** Explicit slug; derived from the name when omitted. */
  id?: string;
  remote?: string;
  verify?: string;
  push?: PushPolicy;
  defaultAgent?: string;
  /** Project template to materialise phases from (TP-05). */
  template?: string;
  /** Knowledge bases attached read-only (KB-03). */
  knowledge?: string[];
  /** The single base this project may write into; curation templates require it (KB-05). */
  writableKnowledge?: string;
};

/**
 * What the phase 9 material needs to be created alongside the project. Optional so the phase 4
 * scaffolding path, and its gate, keep working untouched.
 */
export type CreateProjectDeps = {
  templates?: TemplatesLoader;
  knowledge?: KnowledgeLoader;
  phases?: PhaseService;
};

export type CreateProjectResult = {
  project: ProjectRow;
  created: boolean;
  phases: number;
  knowledge: string[];
};

/**
 * The project scaffold. It moved out of `templates/project/` in phase 9 because
 * `templates/` now means project templates (TP-01) everywhere else (DESIGN §2).
 */
function templateDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scaffold");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function renderConfig(input: CreateProjectInput, id: string): string {
  return [
    `name: ${input.name}`,
    `verify: ${JSON.stringify(input.verify ?? "")}`,
    `push: ${input.push ?? "manual"}`,
    `remote: ${JSON.stringify(input.remote ?? "")}`,
    input.defaultAgent ? `default_agent: ${input.defaultAgent}` : "",
    "",
    `# Optional policy override on top of the agent pack (PE-05):`,
    `# policy:`,
    `#   rules: [ { class: deps_install, verdict: allow } ]`,
    `# project id: ${id}`,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The directories every project starts with (PM-11, §9.6). `doc/` comes from the scaffold; these
 * are the ones an agent has to be able to find without asking.
 */
export const PROJECT_DIRS = ["src", "probes"] as const;

export async function createProject(
  repos: Repos,
  workspace: string,
  input: CreateProjectInput,
  deps: CreateProjectDeps = {},
): Promise<CreateProjectResult> {
  const id = slugify(input.id ?? input.name);
  const projectPath = path.join(workspace, "projects", id);

  // PM-09: no project starts without a brief, whatever the template. Checked first, so a refusal
  // leaves no directory and no row behind.
  if (!input.context?.trim()) {
    throw new Error(
      "a project needs a context brief (PM-09): what it is for, in a few lines — " +
        "goal, actors, systems involved, constraints, definition of done, what is out of scope",
    );
  }

  // Everything a template or a knowledge attachment can get wrong is checked before a single
  // directory is created, so a rejected request leaves nothing behind (TP-03, KB-05).
  const template = input.template ? deps.templates?.getOrThrow(input.template) : undefined;
  if (input.template && !template) {
    throw new Error("templates are not loaded in this process");
  }
  if (template?.requires_writable_knowledge && !input.writableKnowledge) {
    throw new Error(
      `template ${template.id} needs a writable knowledge base (KB-05): pass writableKnowledge`,
    );
  }
  const attachments = [
    ...(input.knowledge ?? []).map((baseId) => ({ baseId, writable: false })),
    ...(input.writableKnowledge
      ? [{ baseId: input.writableKnowledge, writable: true }]
      : []),
  ];
  if (attachments.length > 0 && !deps.knowledge) {
    throw new Error("knowledge is not loaded in this process");
  }
  for (const attachment of attachments) deps.knowledge?.getOrThrow(attachment.baseId);

  const existing = repos.projects.get(id);
  if (existing && (await exists(projectPath))) {
    return {
      project: existing,
      created: false,
      phases: repos.phases.list(existing.id).length,
      knowledge: repos.projectKnowledge.list(existing.id).map((row) => row.base_id),
    };
  }

  await mkdir(path.dirname(projectPath), { recursive: true });
  const scaffoldSource = templateDir();
  if (await exists(scaffoldSource)) {
    await cp(scaffoldSource, projectPath, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } else {
    await mkdir(path.join(projectPath, "doc"), { recursive: true });
  }

  // PM-11: the layout is the system's, not each run's guess. Created empty with a .gitkeep so a
  // directory that is right there is easier to use than a directory that has to be invented —
  // which is how a 1912-line page ended up in doc/ (§9.6). `output/` and `sources/` are made on
  // demand by whoever needs them; these three are the ones every project has an opinion about.
  for (const dir of PROJECT_DIRS) {
    await mkdir(path.join(projectPath, dir), { recursive: true });
    const keep = path.join(projectPath, dir, ".gitkeep");
    if (!(await exists(keep))) await writeFile(keep, "", "utf8");
  }

  // The scaffold ships a placeholder config; overwrite it with the real values.
  await writeFile(path.join(projectPath, CONFIG_FILE), renderConfig(input, id), "utf8");

  // Personalise the doc headers the template left generic.
  for (const doc of ["STATE", "PLAN", "DECISIONS", "QUESTIONS"]) {
    const file = path.join(projectPath, "doc", `${doc}.md`);
    if (!(await exists(file))) continue;
    const content = await readFile(file, "utf8");
    if (content.startsWith(`# ${doc}\n`)) {
      await writeFile(file, content.replace(`# ${doc}`, `# ${doc} — ${input.name}`), "utf8");
    }
  }

  // The scratch directory and its self-ignoring .gitignore, before the first commit (PE-08).
  await ensureScratch(projectPath);
  // The durable toolchain directory (ST-07). Outside the project on purpose: it is build output,
  // not source, and it must not reach the user's git history. Failing here is not fatal — a
  // process running without the volume simply has no toolchain, and the classifier says so.
  await ensureToolchain(id).catch(() => undefined);

  const git = new ProjectGit(projectPath);
  await git.init();
  if (input.remote) await git.setRemote(input.remote);

  const { config } = await readProjectConfig(projectPath);
  const project =
    existing ??
    repos.projects.create({
      id,
      name: input.name,
      path: projectPath,
      context: input.context.trim(),
      repoRemote: input.remote ?? null,
      pushPolicy: input.push ?? "manual",
      verifyCmd: config.verify || null,
      templateId: template?.id ?? null,
    });

  // One chain per project, created now so every phase task has somewhere to go (§16.2).
  if (template && !repos.chains.activeForProject(project.id)) {
    repos.chains.create({ projectId: project.id, title: input.name });
  }

  for (const attachment of attachments) {
    const base = deps.knowledge!.getOrThrow(attachment.baseId);
    repos.projectKnowledge.attach({
      projectId: project.id,
      baseId: base.manifest.id,
      kind: base.manifest.kind,
      writable: attachment.writable,
    });
    repos.events.append({
      type: "knowledge.attached",
      payload: {
        projectId: project.id,
        baseId: base.manifest.id,
        kind: base.manifest.kind,
        writable: attachment.writable,
        actor: "system",
      },
    });
  }

  const phases = template && deps.phases ? deps.phases.materialise(project.id, template) : [];

  repos.events.append({
    type: "system",
    payload: {
      reason: "project created",
      projectId: id,
      path: projectPath,
      ...(template ? { template: template.id } : {}),
    },
  });

  return {
    project,
    created: true,
    phases: phases.length,
    knowledge: attachments.map((a) => a.baseId),
  };
}
