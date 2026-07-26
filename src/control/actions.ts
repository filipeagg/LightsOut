/**
 * The one entry point for everything that changes state (WP-02, MC-01, SU-05, DESIGN §12.0).
 *
 * The panel and the MCP tools are two skins over this file. Each action takes an explicit
 * `actor` so the history can say who did what when both surfaces are in use (WP-11), and each
 * one is the only place its rule lives — a route handler or a tool module that reaches into a
 * repo directly is a review failure, because that is exactly how two surfaces drift apart.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { AgentProfile } from "../agents/schema.js";
import { AgentWriter, agentSource, type AgentPatch } from "../agents/writer.js";
import type { TemplatesLoader } from "../templates/loader.js";
import { TemplateWriter, type TemplatePatch } from "../templates/writer.js";
import type { ProjectTemplate } from "../templates/schema.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import { KnowledgeWriter, type ManifestPatch } from "../knowledge/writer.js";
import type { Vault } from "../vault/vault.js";
import type { VaultEntry, VaultEntryView } from "../vault/schema.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { PhaseService, LaunchPhaseResult } from "../orchestrator/phases.js";
import { createProject, type CreateProjectInput } from "../projects/scaffold.js";
import type { ProjectPhaseRow, ProjectRow, TaskLevel } from "../db/types.js";
import { activeRunFor } from "../views.js";

export type Actor = "mcp" | "panel" | "system";

export type ActionDeps = {
  config: Config;
  repos: Repos;
  agents: AgentsLoader;
  orchestrator: Orchestrator;
  templates?: TemplatesLoader;
  knowledge?: KnowledgeLoader;
  vault?: Vault;
  phases?: PhaseService;
};

export const DOC_NAMES = ["STATE", "PLAN", "DECISIONS", "QUESTIONS"] as const;
export type DocName = (typeof DOC_NAMES)[number];

export class Actions {
  private readonly agentWriter: AgentWriter;
  private readonly templateWriter: TemplateWriter | undefined;
  private readonly knowledgeWriter: KnowledgeWriter | undefined;

  constructor(private readonly deps: ActionDeps) {
    this.agentWriter = new AgentWriter(deps.agents);
    this.templateWriter = deps.templates
      ? new TemplateWriter(deps.templates, (id) => {
          const profile = deps.agents.profile(id);
          return profile !== undefined && profile.enabled;
        })
      : undefined;
    this.knowledgeWriter = deps.knowledge
      ? new KnowledgeWriter(deps.knowledge)
      : undefined;
  }

  /** Say plainly which subsystem a process is missing instead of failing on undefined. */
  private need<T>(value: T | undefined, what: string): T {
    if (!value) throw new Error(`${what} is not available in this process`);
    return value;
  }

  private project(id: string): ProjectRow {
    const row = this.deps.repos.projects.get(id);
    if (!row) throw new Error(`project not found: ${id}`);
    return row;
  }

  private changed(kind: string, id: string, actor: Actor): void {
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind, id, actor },
    });
  }

  // --- Projects and phases -------------------------------------------------

  async createProject(
    actor: Actor,
    input: CreateProjectInput,
  ): Promise<{ project: ProjectRow; created: boolean; phases: number; knowledge: string[] }> {
    const result = await createProject(this.deps.repos, this.deps.config.workspace, input, {
      ...(this.deps.templates ? { templates: this.deps.templates } : {}),
      ...(this.deps.knowledge ? { knowledge: this.deps.knowledge } : {}),
      ...(this.deps.phases ? { phases: this.deps.phases } : {}),
    });
    this.changed("project", result.project.id, actor);
    return result;
  }

  /**
   * Archive or unarchive (PM-08). The reversible half of retiring a project: it drops out of the
   * lists and refuses new launches, but every row and every file stays where it was.
   */
  archiveProject(actor: Actor, projectId: string, archived = true): ProjectRow {
    const project = this.project(projectId);
    if (archived && activeRunFor({ config: this.deps.config, repos: this.deps.repos }, project.id)) {
      throw new Error(`a run is active on ${project.id}; try again when it finishes`);
    }
    const row = this.deps.repos.projects.update(project.id, { archived });
    this.deps.repos.events.append({
      type: archived ? "project.archived" : "project.unarchived",
      payload: { projectId: project.id, actor },
    });
    return row;
  }

  /**
   * Delete a project for good (PM-08). The irreversible half, so it asks to be told what it is
   * about to destroy: `confirm` must be the project id, exactly as WP-11 requires of a
   * destructive action. Files go too unless `keepFiles` is set, and the directory is recomputed
   * from the workspace root rather than read out of `projects.path`, so a doctored row cannot
   * point `rm` somewhere else. The event is written before the rows go: the audit trail has to
   * outlive what it describes.
   */
  async deleteProject(
    actor: Actor,
    projectId: string,
    opts: { confirm: string; keepFiles?: boolean },
  ): Promise<{ deleted: true; filesRemoved: boolean }> {
    const project = this.project(projectId);
    if (opts.confirm !== project.id) {
      throw new Error(`confirm must be the project id ("${project.id}") to delete it`);
    }
    if (activeRunFor({ config: this.deps.config, repos: this.deps.repos }, project.id)) {
      throw new Error(`a run is active on ${project.id}; try again when it finishes`);
    }

    const dir = path.join(this.deps.config.workspace, "projects", project.id);
    this.deps.repos.events.append({
      type: "project.deleted",
      payload: { projectId: project.id, name: project.name, dir, keepFiles: !!opts.keepFiles, actor },
    });
    this.deps.repos.projects.remove(project.id);

    let filesRemoved = false;
    if (!opts.keepFiles) {
      await rm(dir, { recursive: true, force: true });
      filesRemoved = true;
    }
    return { deleted: true, filesRemoved };
  }

  /** An archived project is retired, not paused: it takes no new work until it comes back. */
  private requireNotArchived(projectId: string): ProjectRow {
    const project = this.project(projectId);
    if (project.archived === 1) {
      throw new Error(`${project.id} is archived; unarchive it before launching anything`);
    }
    return project;
  }

  async launchPhase(
    actor: Actor,
    projectId: string,
    phase: string,
    input?: string,
  ): Promise<LaunchPhaseResult> {
    this.requireNotArchived(projectId);
    return this.need(this.deps.phases, "phases").launchPhase(actor, projectId, phase, input);
  }

  async skipPhase(actor: Actor, projectId: string, phase: string): Promise<ProjectPhaseRow> {
    return this.need(this.deps.phases, "phases").skipPhase(actor, projectId, phase);
  }

  /** Look one up by its ulid; the panel addresses phases that way (§12.1b). */
  phase(phaseId: string): ProjectPhaseRow | undefined {
    return this.deps.repos.phases.get(phaseId);
  }

  addPhase(
    actor: Actor,
    projectId: string,
    input: {
      title: string;
      agentId: string;
      instructions: string;
      position?: number;
      deliverable?: string | null;
      verifyCmd?: string | null;
      gate?: "auto" | "human";
    },
  ): ProjectPhaseRow {
    this.requireNotArchived(projectId);
    return this.need(this.deps.phases, "phases").addAdhoc(actor, projectId, input);
  }

  launchTask(
    actor: Actor,
    input: {
      projectId: string;
      title: string;
      spec: string;
      agentId: string;
      level?: TaskLevel;
      verifyCmd?: string | null;
      chainId?: string;
    },
  ): { taskId: string; chainId: string; started: boolean; queued: boolean } {
    this.requireNotArchived(input.projectId);
    this.requireLaunchable(input.agentId);
    const launch = this.deps.orchestrator.launchTask(input);
    this.deps.repos.events.append({
      type: "task.state",
      payload: { taskId: launch.taskIds[0], status: "queued", actor },
    });
    return {
      taskId: launch.taskIds[0]!,
      chainId: launch.chainId,
      started: launch.started,
      queued: launch.queued,
    };
  }

  /** A profile that is disabled stays visible and refuses to run, with the reason (AP-07). */
  private requireLaunchable(agentId: string): AgentProfile {
    const profile = this.deps.agents.profile(agentId);
    if (!profile) {
      const known = [...this.deps.agents.current().profiles.keys()].join(", ") || "none";
      throw new Error(`unknown agent profile: ${agentId} (available: ${known})`);
    }
    if (!profile.enabled) throw new Error(`agent profile ${agentId} is disabled (AP-07)`);
    return profile;
  }

  abortRun(actor: Actor, input: { runId?: string; chainId?: string }): {
    chainId: string;
    aborted: string[];
  } {
    const { repos } = this.deps;
    if (!input.runId && !input.chainId) throw new Error("give runId or chainId");
    const chain = input.chainId
      ? repos.chains.getOrThrow(input.chainId)
      : (() => {
          const run = repos.runs.get(input.runId!);
          if (!run) throw new Error(`run not found: ${input.runId}`);
          return repos.chains.getOrThrow(repos.tasks.getOrThrow(run.task_id).chain_id);
        })();
    const aborted = this.deps.orchestrator.abortChain(chain.id);
    repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "aborted", actor },
    });
    return { chainId: chain.id, aborted };
  }

  async answerDoubt(
    actor: Actor,
    input: { doubtId: string; choice: string; note?: string; projectId?: string },
  ): Promise<{ ref: string; resumed: boolean }> {
    const result = await this.deps.orchestrator.answerDoubt(input);
    this.deps.repos.events.append({
      type: "doubt.answered",
      payload: { ref: result.ref, choice: input.choice, actor },
    });
    return { ref: result.ref, resumed: result.resumed };
  }

  async writeDoc(
    actor: Actor,
    projectId: string,
    doc: DocName,
    content: string,
  ): Promise<{ written: true; doc: DocName }> {
    const project = this.project(projectId);
    // A run rewrites these files as it goes; a write underneath it would be lost or would
    // clobber the agent's own edit (MC-04).
    if (activeRunFor({ config: this.deps.config, repos: this.deps.repos }, project.id)) {
      throw new Error(`a run is active on ${project.id}; try again when it finishes`);
    }
    await writeFile(path.join(project.path, "doc", `${doc}.md`), content, "utf8");
    this.deps.repos.events.append({
      type: "system",
      payload: { reason: "doc written", projectId: project.id, doc, actor },
    });
    return { written: true, doc };
  }

  async readDoc(projectId: string, doc: DocName): Promise<{ content: string; path: string }> {
    const project = this.project(projectId);
    const file = path.join(project.path, "doc", `${doc}.md`);
    try {
      return { content: await readFile(file, "utf8"), path: file };
    } catch {
      throw new Error(`${doc}.md does not exist in ${project.id}`);
    }
  }

  // --- Knowledge attachment ------------------------------------------------

  attachKnowledge(
    actor: Actor,
    projectId: string,
    baseId: string,
    writable = false,
  ): { baseId: string; writable: boolean } {
    const project = this.project(projectId);
    const base = this.need(this.deps.knowledge, "knowledge").getOrThrow(baseId);
    if (writable) {
      const existing = this.deps.repos.projectKnowledge.writableBase(project.id);
      if (existing && existing !== baseId) {
        throw new Error(`${project.id} already writes into ${existing}; only one base may be writable (KB-05)`);
      }
    }
    this.deps.repos.projectKnowledge.attach({
      projectId: project.id,
      baseId: base.manifest.id,
      kind: base.manifest.kind,
      writable,
    });
    this.deps.repos.events.append({
      type: "knowledge.attached",
      payload: { projectId: project.id, baseId, kind: base.manifest.kind, writable, actor },
    });
    return { baseId, writable };
  }

  detachKnowledge(actor: Actor, projectId: string, baseId: string): { detached: boolean } {
    const project = this.project(projectId);
    const detached = this.deps.repos.projectKnowledge.detach(project.id, baseId);
    if (detached) {
      this.deps.repos.events.append({
        type: "knowledge.detached",
        payload: { projectId: project.id, baseId, actor },
      });
    }
    return { detached };
  }

  // --- The configuration library ------------------------------------------

  async writeAgent(actor: Actor, id: string, patch: AgentPatch): Promise<AgentProfile> {
    const profile = await this.agentWriter.put(id, patch);
    this.changed("agent", id, actor);
    return profile;
  }

  async setAgentEnabled(actor: Actor, id: string, enabled: boolean): Promise<AgentProfile> {
    const profile = await this.agentWriter.setEnabled(id, enabled);
    this.changed("agent", id, actor);
    return profile;
  }

  async deleteAgent(actor: Actor, id: string): Promise<{ revealedBuiltin: boolean }> {
    const result = await this.agentWriter.remove(id);
    this.changed("agent", id, actor);
    return { revealedBuiltin: result.revealedBuiltin };
  }

  async reloadAgents(actor: Actor): Promise<{ loaded: number; packs: number }> {
    const report = await this.deps.agents.load();
    this.changed("agent", "*", actor);
    return { loaded: report.loaded, packs: report.packs };
  }

  agentSource(id: string): Promise<"builtin" | "workspace" | undefined> {
    return agentSource(this.deps.agents, id);
  }

  async writeTemplate(
    actor: Actor,
    id: string,
    patch: TemplatePatch,
  ): Promise<ProjectTemplate> {
    const template = await this.need(this.templateWriter, "templates").put(id, patch);
    this.changed("template", id, actor);
    return template;
  }

  async deleteTemplate(actor: Actor, id: string): Promise<{ revealedBuiltin: boolean }> {
    const result = await this.need(this.templateWriter, "templates").remove(id);
    this.changed("template", id, actor);
    return { revealedBuiltin: result.revealedBuiltin };
  }

  async writeKnowledge(actor: Actor, baseId: string, patch: ManifestPatch) {
    const manifest = await this.need(this.knowledgeWriter, "knowledge").putManifest(
      baseId,
      patch,
    );
    this.changed("knowledge", baseId, actor);
    return manifest;
  }

  async writeKnowledgeDoc(
    actor: Actor,
    baseId: string,
    file: string,
    content: string,
  ): Promise<{ file: string }> {
    const written = await this.need(this.knowledgeWriter, "knowledge").putDocument(
      baseId,
      file,
      content,
    );
    this.changed("knowledge", baseId, actor);
    return { file: written };
  }

  async deleteKnowledge(actor: Actor, baseId: string): Promise<{ deleted: true }> {
    const attached = this.deps.repos.projects
      .list({ includeArchived: true })
      .filter((project) =>
        this.deps.repos.projectKnowledge.list(project.id).some((row) => row.base_id === baseId),
      )
      .map((project) => project.id);
    await this.need(this.knowledgeWriter, "knowledge").remove(baseId, attached);
    this.changed("knowledge", baseId, actor);
    return { deleted: true };
  }

  /** Values are write-only: this returns the view, never what was stored (VT-03). */
  async writeVaultEntry(
    actor: Actor,
    entryId: string,
    patch: Partial<Omit<VaultEntry, "id" | "fields">> & {
      fields?: Record<string, string | null>;
    },
  ): Promise<VaultEntryView> {
    const view = await this.need(this.deps.vault, "vault").put(entryId, patch);
    this.changed("vault", entryId, actor);
    return view;
  }

  async deleteVaultEntry(actor: Actor, entryId: string): Promise<{ deleted: boolean }> {
    const deleted = await this.need(this.deps.vault, "vault").remove(entryId);
    this.changed("vault", entryId, actor);
    return { deleted };
  }
}
