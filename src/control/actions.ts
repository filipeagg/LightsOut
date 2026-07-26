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
import {
  KnowledgeWriter,
  listWorkspaceFolders,
  type ManifestPatch,
  type WorkspaceFolder,
} from "../knowledge/writer.js";
import type { Vault } from "../vault/vault.js";
import type { VaultEntry, VaultEntryView } from "../vault/schema.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { PhaseService, LaunchPhaseResult } from "../orchestrator/phases.js";
import { createProject, type CreateProjectInput } from "../projects/scaffold.js";
import type { ProjectPhaseRow, ProjectRow, TaskLevel } from "../db/types.js";
import { existsSync } from "node:fs";
import { activeRunFor } from "../views.js";
import { validateArea } from "../projects/areas.js";
import { Classifier } from "../policy/classify.js";
import {
  hostPathFor,
  listProjectDocs,
  readProjectDoc as readDocFile,
  type DocContent,
  type DocEntry,
} from "../projects/docs-index.js";

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

  /**
   * The configuration audit trail. `op` matters: a trail that only says "knowledge/efemis
   * changed" cannot answer "was it deleted, and by whom" — which is exactly the question asked
   * when a base went missing, and the reason the answer took a database query and a guess.
   */
  private changed(kind: string, id: string, actor: Actor, op: "write" | "delete" = "write"): void {
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind, id, actor, op },
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

  /** OR-10: the request for this run and what is expected back, both required. */
  async launchPhase(
    actor: Actor,
    projectId: string,
    phase: string,
    input: { request: string; expects: string },
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
      /** What comes back (OR-10); refused when missing. */
      expects: string;
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

  /**
   * Abort a chain (OR-06, OR-09): the queued tasks are dropped **and** the run in flight is
   * stopped. `letCurrentFinish` keeps the old behaviour of letting the current agent finish, which
   * is occasionally what someone wants and never what they expect by default.
   */
  async abortRun(
    actor: Actor,
    input: { runId?: string; chainId?: string; letCurrentFinish?: boolean },
  ): Promise<{ chainId: string; aborted: string[]; stopped: string[] }> {
    const { repos } = this.deps;
    if (!input.runId && !input.chainId) throw new Error("give runId or chainId");
    const chain = input.chainId
      ? repos.chains.getOrThrow(input.chainId)
      : (() => {
          const run = repos.runs.get(input.runId!);
          if (!run) throw new Error(`run not found: ${input.runId}`);
          return repos.chains.getOrThrow(repos.tasks.getOrThrow(run.task_id).chain_id);
        })();
    const result = await this.deps.orchestrator.abortChain(chain.id, {
      ...(input.letCurrentFinish ? { letCurrentFinish: true } : {}),
      reason: `chain aborted by ${actor}`,
    });
    repos.events.append({
      type: "chain.state",
      payload: { chainId: chain.id, status: "aborted", actor, stopped: result.stopped.length },
    });
    return { chainId: chain.id, aborted: result.aborted, stopped: result.stopped };
  }

  /**
   * Stop the run that is executing right now and leave the chain paused (OR-09). The counterpart
   * to abort: this one does not touch the queue, so the same task can be launched again, or a
   * different one, once whatever the agent was doing has been looked at.
   */
  async stopRun(
    actor: Actor,
    input: { runId?: string; projectId?: string },
  ): Promise<{
    runId: string;
    stopped: boolean;
    doubtsClosed: string[];
    reconciled: boolean;
    chainPaused: boolean;
  }> {
    const { repos, orchestrator } = this.deps;
    const runId =
      input.runId ??
      (() => {
        if (!input.projectId) throw new Error("give runId or projectId");
        const live = orchestrator.live.forProject(input.projectId)[0];
        if (live) return live.runId;
        const active = repos.runs.listActive();
        const found = active.find(
          (run) => repos.tasks.get(run.task_id)?.project_id === input.projectId,
        );
        if (!found) throw new Error(`no run in flight for project ${input.projectId}`);
        return found.id;
      })();

    const run = repos.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const task = repos.tasks.get(run.task_id);
    const result = await orchestrator.stopRun(runId, `stopped by ${actor}`);

    // The chain must not carry on to the next task after a stop: that is what abort is for, and
    // silently continuing would make the stop look like it did nothing. But a stop that found
    // nothing to stop must not pause anything either — a request that arrives just as the run
    // finishes would otherwise leave a chain that completed looking paused.
    let chainPaused = false;
    if (task && (result.stopped || result.reconciled)) {
      const chain = repos.chains.get(task.chain_id);
      if (chain && chain.status === "active") {
        repos.chains.setStatus(chain.id, "paused");
        repos.events.append({
          type: "chain.state",
          payload: { chainId: chain.id, status: "paused", reason: "run stopped", actor },
        });
        chainPaused = true;
      }
    }

    repos.events.append({
      runId,
      type: "run.state",
      payload: { status: "aborted", reason: `stopped by ${actor}`, actor },
    });
    return { ...result, chainPaused };
  }

  /**
   * Restart a chain that stopped (OR-05). The counterpart to the pause: a chain interrupted by a
   * container restart or a failed task had no way back before this, which left a project visibly
   * stuck with no action that could unstick it.
   */
  resumeChain(
    actor: Actor,
    input: { chainId?: string; projectId?: string },
  ): { chainId: string; requeued: string[]; started: boolean } {
    const { repos } = this.deps;
    const chainId =
      input.chainId ??
      (() => {
        if (!input.projectId) throw new Error("give chainId or projectId");
        this.requireNotArchived(input.projectId);
        const chain = repos.chains.latestForProject(input.projectId);
        if (!chain) throw new Error(`no chain for project ${input.projectId}`);
        return chain.id;
      })();
    const result = this.deps.orchestrator.resumeChain(chainId);
    repos.events.append({
      type: "chain.state",
      payload: { chainId: result.chainId, status: "active", reason: "resumed", actor },
    });
    return result;
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

  // --- Reading the project's documents (PM-10, DESIGN §9.4) ------------------

  /** Every Markdown file the project holds, with its size and its format verdict. */
  async listDocs(projectId: string): Promise<{
    projectId: string;
    root: string;
    hostRoot: string | null;
    docs: (DocEntry & { hostPath: string | null })[];
  }> {
    const project = this.project(projectId);
    const { config } = this.deps;
    const docs = await listProjectDocs(project.path);
    return {
      projectId: project.id,
      root: project.path,
      hostRoot: hostPathFor(config.workspace, config.workspaceHost, project.path),
      docs: docs.map((entry) => ({
        ...entry,
        hostPath: hostPathFor(
          config.workspace,
          config.workspaceHost,
          path.join(project.path, entry.path),
        ),
      })),
    };
  }

  /**
   * The content of one of them. Both paths are reported: the container one, and the same file on
   * the user's own machine, because a person may want to open it in their editor.
   */
  async readProjectDoc(
    projectId: string,
    relative: string,
  ): Promise<DocContent & { projectId: string; absolutePath: string; hostPath: string | null }> {
    const project = this.project(projectId);
    const { config } = this.deps;
    try {
      const doc = await readDocFile(project.path, relative);
      const absolutePath = path.join(project.path, doc.path);
      return {
        ...doc,
        projectId: project.id,
        absolutePath,
        hostPath: hostPathFor(config.workspace, config.workspaceHost, absolutePath),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot read ${relative} in ${project.id}: ${detail}`);
    }
  }

  // --- Learned allows (PE-10, DESIGN §7.4) -----------------------------------

  /** What a human has already allowed at a gate, most used first. */
  listLearnedAllows(): {
    allows: {
      id: string;
      shape: string;
      sample: string;
      actionClass: string;
      learnedFrom: string | null;
      addedBy: string;
      uses: number;
      lastUsedAt: string | null;
      createdAt: string;
    }[];
  } {
    return {
      allows: this.deps.repos.learned.list().map((row) => ({
        id: row.id,
        shape: row.shape,
        sample: row.sample,
        actionClass: row.action_class,
        learnedFrom: row.learned_from,
        addedBy: row.added_by,
        uses: row.uses,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
      })),
    };
  }

  /** Forget one: the next command of that shape asks again (PE-10). */
  forgetLearnedAllow(actor: Actor, shapeOrId: string): { forgotten: string } {
    const row = this.deps.repos.learned.remove(shapeOrId);
    if (!row) throw new Error(`no learned allow matches: ${shapeOrId}`);
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind: "learned_allow", id: row.shape, op: "remove", actor },
    });
    return { forgotten: row.shape };
  }

  // --- Read-only workspace areas (PE-09, DESIGN §9.5) ------------------------

  /** What this project may read outside itself, with both paths for each area. */
  listAreas(projectId: string): {
    projectId: string;
    areas: {
      id: string;
      path: string;
      absolute: string;
      hostPath: string | null;
      note: string | null;
      addedBy: string;
      createdAt: string;
    }[];
  } {
    const project = this.project(projectId);
    const { config } = this.deps;
    return {
      projectId: project.id,
      areas: this.deps.repos.areas.list(project.id).map((row) => {
        const absolute = path.resolve(config.workspace, row.path);
        return {
          id: row.id,
          path: row.path,
          absolute,
          hostPath: hostPathFor(config.workspace, config.workspaceHost, absolute),
          note: row.note,
          addedBy: row.added_by,
          createdAt: row.created_at,
        };
      }),
    };
  }

  /**
   * Declare a directory of the workspace this project may read (PE-09). Every rule about what
   * cannot be an area lives in `validateArea`, so both surfaces refuse the same things for the
   * same stated reason.
   */
  addArea(
    actor: Actor,
    projectId: string,
    input: { path: string; note?: string },
  ): { projectId: string; path: string; absolute: string; hostPath: string | null } {
    const project = this.project(projectId);
    const { config } = this.deps;
    const target = validateArea(config.workspace, project.path, input.path);
    this.deps.repos.areas.add({
      projectId: project.id,
      path: target.relative,
      ...(input.note ? { note: input.note } : {}),
      addedBy: actor,
    });
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind: "area", id: `${project.id}:${target.relative}`, op: "add", actor },
    });
    return {
      projectId: project.id,
      path: target.relative,
      absolute: target.absolute,
      hostPath: hostPathFor(config.workspace, config.workspaceHost, target.absolute),
    };
  }

  removeArea(
    actor: Actor,
    projectId: string,
    pathOrId: string,
  ): { projectId: string; removed: string } {
    const project = this.project(projectId);
    const normalised = pathOrId.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const row =
      this.deps.repos.areas.remove(project.id, normalised) ??
      this.deps.repos.areas.remove(project.id, pathOrId);
    if (!row) throw new Error(`${pathOrId} is not an area of ${project.id}`);
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind: "area", id: `${project.id}:${row.path}`, op: "remove", actor },
    });
    return { projectId: project.id, removed: row.path };
  }

  /**
   * Where is this, really (MC-08)? Translates between the container's paths and the user's own,
   * in either direction, and says whether the thing exists. A person told `/workspace/projects/x`
   * cannot open it, and a guess about the mapping is how a conversation ends up about the wrong
   * file.
   */
  resolvePath(input: { path?: string; projectId?: string }): {
    workspace: { container: string; host: string | null };
    container: string | null;
    host: string | null;
    relative: string | null;
    exists: boolean;
    inWorkspace: boolean;
  } {
    const { config } = this.deps;
    const workspace = {
      container: config.workspace,
      host: config.workspaceHost || null,
    };
    let raw = input.path?.trim() ?? "";
    if (input.projectId) {
      const project = this.project(input.projectId);
      raw = raw ? path.join(project.path, raw) : project.path;
    }
    if (!raw) {
      return {
        workspace,
        container: config.workspace,
        host: workspace.host,
        relative: "",
        exists: true,
        inWorkspace: true,
      };
    }

    // A host path coming back the other way: strip the host root and re-root it in the container.
    // Separators are normalised and collapsed first, because a path pasted from Windows arrives
    // with backslashes, sometimes doubled by whatever quoted it.
    let container = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (config.workspaceHost) {
      const host = config.workspaceHost
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/\/+$/, "");
      if (container.toLowerCase().startsWith(host.toLowerCase())) {
        container = path.posix.join(config.workspace, container.slice(host.length));
      }
    }
    if (!container.startsWith("/")) container = path.posix.join(config.workspace, container);

    const resolved = path.resolve(container);
    const inWorkspace = Classifier.isInside(config.workspace, resolved);
    const relative = inWorkspace
      ? path.relative(path.resolve(config.workspace), resolved).split(path.sep).join("/")
      : null;
    return {
      workspace,
      container: resolved,
      host: hostPathFor(config.workspace, config.workspaceHost, resolved),
      relative,
      exists: existsSync(resolved),
      inWorkspace,
    };
  }

  /**
   * Rewrite the project's context brief (PM-09). The one field a project cannot be without, and
   * the one most likely to need correcting once the work has started.
   */
  setProjectContext(
    actor: Actor,
    projectId: string,
    context: string,
  ): { projectId: string; context: string } {
    const project = this.project(projectId);
    if (!context.trim()) {
      throw new Error("the context brief cannot be empty (PM-09)");
    }
    const updated = this.deps.repos.projects.update(project.id, { context: context.trim() });
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind: "project", id: project.id, op: "context", actor },
    });
    return { projectId: updated.id, context: updated.context };
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
      if (base.source !== undefined) {
        throw new Error(
          `${baseId} reads its documents from ${base.source}; a linked base cannot be the ` +
            `writable one (KB-05, KB-08)`,
        );
      }
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
    this.changed("agent", id, actor, "delete");
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
    this.changed("template", id, actor, "delete");
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

  async deleteKnowledgeDoc(
    actor: Actor,
    baseId: string,
    file: string,
  ): Promise<{ deleted: true }> {
    await this.need(this.knowledgeWriter, "knowledge").removeDocument(baseId, file);
    this.changed("knowledge", `${baseId}/${file}`, actor, "delete");
    return { deleted: true };
  }

  /**
   * Adopt a folder of documents as a knowledge base (KB-10): write the manifest, and an index
   * only if it has none. Under `knowledge/` the folder becomes the base in place; anywhere else
   * in the workspace it gets a base that links to it.
   */
  async adoptKnowledge(
    actor: Actor,
    folder: string,
    patch: Omit<ManifestPatch, "source"> & { id?: string },
  ) {
    const result = await this.need(this.knowledgeWriter, "knowledge").adopt(folder, patch);
    this.changed("knowledge", result.manifest.id, actor);
    this.deps.repos.events.append({
      type: "knowledge.adopted",
      payload: { baseId: result.manifest.id, folder, inPlace: result.inPlace, actor },
    });
    return result;
  }

  /** The workspace tree a base could be linked to or adopted from (KB-08, KB-10). */
  async knowledgeFolders(): Promise<WorkspaceFolder[]> {
    // Mark the folders that already are bases, so the picker can say so instead of offering to
    // adopt something that is adopted.
    const basesByPath = new Map<string, string>();
    for (const base of this.deps.knowledge?.list() ?? []) {
      basesByPath.set(`knowledge/${base.manifest.id}`, base.manifest.id);
      if (base.source) basesByPath.set(base.source, base.manifest.id);
    }
    return listWorkspaceFolders(this.deps.config.workspace, { basesByPath });
  }

  /** Folders under `knowledge/` holding documents and no manifest yet (KB-10). */
  adoptableFolders() {
    return this.need(this.deps.knowledge, "knowledge").adoptable();
  }

  async deleteKnowledge(actor: Actor, baseId: string): Promise<{ deleted: true }> {
    const attached = this.deps.repos.projects
      .list({ includeArchived: true })
      .filter((project) =>
        this.deps.repos.projectKnowledge.list(project.id).some((row) => row.base_id === baseId),
      )
      .map((project) => project.id);
    await this.need(this.knowledgeWriter, "knowledge").remove(baseId, attached);
    this.changed("knowledge", baseId, actor, "delete");
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
    this.changed("vault", entryId, actor, "delete");
    return { deleted };
  }
}
