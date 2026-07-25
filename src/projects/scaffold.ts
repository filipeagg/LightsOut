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
import { CONFIG_FILE, readProjectConfig } from "./config.js";

export type CreateProjectInput = {
  name: string;
  /** Explicit slug; derived from the name when omitted. */
  id?: string;
  remote?: string;
  verify?: string;
  push?: PushPolicy;
  defaultAgent?: string;
};

export type CreateProjectResult = {
  project: ProjectRow;
  created: boolean;
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

export async function createProject(
  repos: Repos,
  workspace: string,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  const id = slugify(input.id ?? input.name);
  const projectPath = path.join(workspace, "projects", id);

  const existing = repos.projects.get(id);
  if (existing && (await exists(projectPath))) {
    return { project: existing, created: false };
  }

  await mkdir(path.dirname(projectPath), { recursive: true });
  const template = templateDir();
  if (await exists(template)) {
    await cp(template, projectPath, { recursive: true, force: false, errorOnExist: false });
  } else {
    await mkdir(path.join(projectPath, "doc"), { recursive: true });
  }

  // The template ships a placeholder config; overwrite it with the real values.
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
      repoRemote: input.remote ?? null,
      pushPolicy: input.push ?? "manual",
      verifyCmd: config.verify || null,
    });

  repos.events.append({
    type: "system",
    payload: { reason: "project created", projectId: id, path: projectPath },
  });

  return { project, created: true };
}
