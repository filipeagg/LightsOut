/**
 * The one entry point for everything that changes state (WP-02, MC-01, SU-05, DESIGN §12.0).
 *
 * The panel and the MCP tools are two skins over this file. Each action takes an explicit
 * `actor` so the history can say who did what when both surfaces are in use (WP-11), and each
 * one is the only place its rule lives — a route handler or a tool module that reaches into a
 * repo directly is a review failure, because that is exactly how two surfaces drift apart.
 */
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { AgentProfile } from "../agents/schema.js";
import {
  modelCatalog,
  resolveProfile,
  validateModelChoice,
  type ModelChoice,
} from "../agents/effective.js";
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
import { readProjectConfig } from "../projects/config.js";
import type { ProjectPhaseRow, ProjectRow, TaskLevel } from "../db/types.js";
import { existsSync } from "node:fs";
import { activeRunFor } from "../views.js";
import { validateArea } from "../projects/areas.js";
import { detectPreview, isPreviewPlan } from "../preview/detect.js";
import type { AreaAccess } from "../db/repos/areas.js";
import {
  TOOLCHAIN_MANAGERS,
  isRootManager,
  isToolchainManager,
  toolchainRoot,
} from "../projects/toolchain.js";
import type { ToolchainGrantRow } from "../db/repos/toolchain-grants.js";
import type { PreviewManager, PreviewView } from "../preview/manager.js";
import {
  CAPABILITIES,
  checkCapabilities,
  explainMismatch,
  isCapability,
  type Capability,
} from "../policy/capabilities.js";
import { Classifier } from "../policy/classify.js";
import {
  hostPathFor,
  listProjectDocs,
  readProjectDoc as readDocFile,
  type DocContent,
  type DocEntry,
} from "../projects/docs-index.js";
import {
  docHistoryDir,
  hashContent,
  knowledgeHistoryDir,
  snapshotFile,
} from "../projects/doc-history.js";
import { applyEdits, type DocEdit } from "../projects/doc-patch.js";
import { INBOX_REL } from "../acp/prompt.js";
import { describeCron, nextFire, parseCron } from "../triggers/cron.js";
import type { TriggerRow } from "../db/repos/triggers.js";

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
  /**
   * Engine auth, so a launch onto an unauthenticated engine is refused in one second instead of
   * dying on AUTH_REQUIRED two seconds into a run (OR-11). Optional: a process without it simply
   * does not make that check.
   */
  health?: { engines(): Promise<{ engine: string; detected: boolean; auth: boolean }[]> };
  /** Development servers a person can open (PV-01); absent in a process that runs none. */
  previews?: PreviewManager;
};

export const DOC_NAMES = ["STATE", "PLAN", "DECISIONS", "QUESTIONS"] as const;
export type DocName = (typeof DOC_NAMES)[number];

/**
 * Documents the system itself keeps adding to (§8.3). They were append-only by convention and
 * replaceable by tool, which is not a convention, it is a hope. `write_doc` refuses them (MC-13).
 */
export const APPEND_ONLY_DOCS: readonly DocName[] = ["DECISIONS", "QUESTIONS"];

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
    // PV-03: a preview of a project that no longer exists is a process nobody will ever stop.
    await this.deps.previews
      ?.stop({ projectId: project.id }, "the project was deleted")
      .catch(() => undefined);
    this.deps.repos.previews.removeForProject(project.id);
    // ST-07: the grants are a power over a directory that is about to stop existing, and a row
    // pointing at a deleted project is a foreign key waiting to fail.
    this.deps.repos.toolchainGrants.removeForProject(project.id);
    this.deps.repos.projects.remove(project.id);

    let filesRemoved = false;
    if (!opts.keepFiles) {
      await rm(dir, { recursive: true, force: true });
      // The toolchain is build output of this project and nothing else; it goes with it. Kept
      // when the user asked to keep the files, so an accidental delete loses nothing rebuildable.
      await rm(toolchainRoot(project.id), { recursive: true, force: true }).catch(() => undefined);
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
    input: {
      request: string;
      expects: string;
      /** Engine and model for this run of the phase, overriding the agent's (AP-09). */
      engine?: string;
      model?: string;
      reasoning?: string;
    },
  ): Promise<LaunchPhaseResult> {
    this.requireNotArchived(projectId);
    const phases = this.need(this.deps.phases, "phases");
    if (input.engine || input.model || input.reasoning) {
      // OR-11: check it against the phase's own agent before the phase is marked running.
      const row =
        this.deps.repos.phases.getByRef(projectId, phase) ?? this.deps.repos.phases.get(phase);
      if (row) await this.requireModelChoice(row.agent_id, input);
    }
    return phases.launchPhase(actor, projectId, phase, input);
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

  /**
   * What a task needs, against what its agent's packs allow (PE-12). Returns the grant pack to
   * apply, or throws the refusal that says how to fix it — before a single token is spent.
   */
  private async requireCapabilities(input: {
    projectId: string;
    agentId: string;
    needs?: string[];
    grants?: string[];
  }): Promise<{ needs: Capability[]; grants: Capability[] }> {
    const needs = (input.needs ?? []).map((value) => {
      if (!isCapability(value)) {
        throw new Error(`unknown capability: ${value} (one of ${CAPABILITIES.join(", ")})`);
      }
      return value;
    });
    const grants = (input.grants ?? []).map((value) => {
      if (!isCapability(value)) {
        throw new Error(`unknown capability: ${value} (one of ${CAPABILITIES.join(", ")})`);
      }
      return value;
    });
    if (needs.length === 0) return { needs, grants };

    const project = this.project(input.projectId);
    const profile = this.deps.agents.profileOrThrow(input.agentId);
    const { pack: projectPack } = await readProjectConfig(project.path);
    const checks = checkCapabilities(needs, {
      ...(projectPack ? { project: projectPack } : {}),
      // PE-14: the pack *as this profile runs it* — its own writeScopes and capabilities
      // included, so a launch is checked against what the agent can actually do.
      ...(this.deps.agents.packFor(profile) ? { agent: this.deps.agents.packFor(profile) } : {}),
      ...(this.deps.agents.pack("build") ?? this.deps.agents.pack("default")
        ? { default: this.deps.agents.pack("build") ?? this.deps.agents.pack("default") }
        : {}),
    });
    const missing = checks.filter((check) => !check.granted && !grants.includes(check.capability));
    if (missing.length === 0) return { needs, grants };

    // Which builtin could do it, so the refusal is a route and not a wall.
    const alternatives = [...this.deps.agents.current().profiles.values()]
      .filter((candidate) => {
        if (!candidate.enabled) return false;
        const pack = this.deps.agents.packFor(candidate);
        return checkCapabilities(
          missing.map((m) => m.capability),
          { ...(pack ? { agent: pack } : {}) },
        ).every((check) => check.granted);
      })
      .map((candidate) => ({ agentId: candidate.id, policy: candidate.policy }))
      .slice(0, 3);

    throw new Error(explainMismatch({ agentId: input.agentId, missing, alternatives }));
  }

  /**
   * The engine and model this launch chose, checked against the catalog and against engine health
   * before a task row exists (AP-09, OR-11). Returns what to store on the task, or throws the
   * refusal — which always names the accepted values, because a rejection that does not say what
   * was expected costs the caller another round trip.
   */
  private async requireModelChoice(
    agentId: string,
    choice: ModelChoice | undefined,
  ): Promise<{ engine?: string; model?: string; reasoning?: string }> {
    const profile = this.deps.agents.profileOrThrow(agentId);
    const problem = validateModelChoice(profile, choice);
    if (problem) throw new Error(problem);

    const resolved = resolveProfile(profile, choice);
    if (this.deps.health) {
      const engines = await this.deps.health.engines();
      const target = engines.find((e) => e.engine === resolved.engine);
      if (target && (!target.detected || !target.auth)) {
        throw new Error(
          `engine ${resolved.engine} is not ready (${target.detected ? "not authenticated" : "not detected"}); ` +
            `reconnect it from the panel before launching onto it, or launch on the other engine`,
        );
      }
    }
    return {
      ...(choice?.engine ? { engine: choice.engine } : {}),
      ...(choice?.model ? { model: choice.model } : {}),
      ...(choice?.reasoning ? { reasoning: choice.reasoning } : {}),
    };
  }

  async launchTask(
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
      /** What this task needs, checked before it starts (PE-12). */
      needs?: string[];
      /** What to grant it for this run only (PE-12). */
      grants?: string[];
      /** The engine, model and reasoning this launch chooses, overriding the profile (AP-09). */
      engine?: string;
      model?: string;
      reasoning?: string;
    },
  ): Promise<{ taskId: string; chainId: string; started: boolean; queued: boolean }> {
    this.requireNotArchived(input.projectId);
    this.requireLaunchable(input.agentId);
    const capabilities = await this.requireCapabilities(input);
    const chosen = await this.requireModelChoice(input.agentId, input);
    const {
      needs: _declared,
      grants: _asked,
      engine: _engine,
      model: _model,
      reasoning: _reasoning,
      ...rest
    } = input;
    const launch = this.deps.orchestrator.launchTask({
      ...rest,
      ...(capabilities.needs.length ? { needs: capabilities.needs } : {}),
      ...(capabilities.grants.length ? { grants: capabilities.grants } : {}),
      ...chosen,
    });
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

  /**
   * A whole chain, with every task checked before any of it is queued (OR-11).
   *
   * It goes through here rather than straight to the orchestrator so that the capability check
   * (PE-12) and the model check (AP-09) apply to a chain exactly as they apply to a single task:
   * a chain whose fourth task names a model that does not exist should be refused now, not four
   * tasks from now.
   */
  async launchChain(
    actor: Actor,
    input: {
      projectId: string;
      title: string;
      tasks: {
        title: string;
        spec: string;
        expects: string;
        agentId: string;
        level?: TaskLevel;
        verifyCmd?: string | null;
        needs?: string[];
        grants?: string[];
        engine?: string;
        model?: string;
        reasoning?: string;
      }[];
    },
  ): Promise<{ chainId: string; taskIds: string[]; started: boolean; queued: boolean }> {
    this.requireNotArchived(input.projectId);

    const prepared = [];
    for (const task of input.tasks) {
      this.requireLaunchable(task.agentId);
      const capabilities = await this.requireCapabilities({
        projectId: input.projectId,
        agentId: task.agentId,
        ...(task.needs ? { needs: task.needs } : {}),
        ...(task.grants ? { grants: task.grants } : {}),
      });
      const chosen = await this.requireModelChoice(task.agentId, task);
      const { needs: _n, grants: _g, engine: _e, model: _m, reasoning: _r, ...rest } = task;
      prepared.push({
        ...rest,
        ...(capabilities.needs.length ? { needs: capabilities.needs } : {}),
        ...(capabilities.grants.length ? { grants: capabilities.grants } : {}),
        ...chosen,
      });
    }

    const launch = this.deps.orchestrator.launchChain({
      projectId: input.projectId,
      title: input.title,
      tasks: prepared,
    });
    for (const taskId of launch.taskIds) {
      this.deps.repos.events.append({
        type: "task.state",
        payload: { taskId, status: "queued", actor },
      });
    }
    return launch;
  }

  /**
   * The package managers a project may install into its own durable toolchain with (ST-07).
   *
   * Ordinarily granted by answering the permission doubt, which is where the user sees the actual
   * command. This is the other two thirds: seeing what has been granted, and withdrawing it.
   */
  listToolchainGrants(projectId?: string): {
    grants: ToolchainGrantRow[];
    managers: string[];
    root: string | null;
  } {
    if (projectId) this.project(projectId);
    return {
      grants: this.deps.repos.toolchainGrants.list(projectId),
      managers: [...TOOLCHAIN_MANAGERS],
      root: projectId ? toolchainRoot(projectId) : null,
    };
  }

  grantToolchain(
    actor: Actor,
    projectId: string,
    manager: string,
    note?: string,
  ): ToolchainGrantRow {
    this.project(projectId);
    if (isRootManager(manager)) {
      throw new Error(
        `${manager} needs root and cannot be granted here (ST-08): it is asked for with a ` +
          `toolchain doubt, approved by you, and applied by rebuilding the image yourself`,
      );
    }
    if (!isToolchainManager(manager)) {
      throw new Error(
        `unknown package manager: ${manager} (one of ${TOOLCHAIN_MANAGERS.join(", ")})`,
      );
    }
    const grant = this.deps.repos.toolchainGrants.add({
      projectId,
      manager,
      ...(note !== undefined ? { note } : {}),
      grantedBy: actor,
    });
    this.changed("toolchain_grant", `${projectId}:${manager}`, actor, "write");
    return grant;
  }

  revokeToolchainGrant(actor: Actor, projectId: string, manager: string): { revoked: boolean } {
    const removed = this.deps.repos.toolchainGrants.remove(projectId, manager);
    if (!removed) return { revoked: false };
    this.changed("toolchain_grant", `${projectId}:${manager}`, actor, "delete");
    return { revoked: true };
  }

  // --- Previews (PV-01..03) ------------------------------------------------

  /**
   * Start a development server the user can open in their own browser.
   *
   * It is here rather than in the agent's terminal because a server does not end: run as an
   * ordinary command it holds the run open until the watchdog kills it (PV-02). LightsOut owns
   * the process, publishes the port and keeps it alive after the run finishes.
   */
  /**
   * Start a preview. `command` is optional (PV-07): without one, the project is inspected and the
   * choice is made here, so the button has nothing to type into.
   */
  async startPreview(
    actor: Actor,
    input: {
      projectId: string;
      command?: string;
      port?: number;
      cwd?: string;
      ttlMinutes?: number;
    },
  ): Promise<PreviewView & { detected?: string }> {
    this.requireNotArchived(input.projectId);
    const previews = this.need(this.deps.previews, "previews");

    let command = input.command?.trim();
    let detected: string | undefined;
    if (!command) {
      const project = this.project(input.projectId);
      const plan = detectPreview(path.resolve(project.path, input.cwd ?? "."));
      if (!isPreviewPlan(plan)) throw new Error(plan.reason);
      command = plan.command;
      detected = plan.reason;
    }

    const started = await previews.start({
      projectId: input.projectId,
      command,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.ttlMinutes !== undefined ? { ttlMinutes: input.ttlMinutes } : {}),
      startedBy: actor,
    });
    return detected ? { ...started, detected } : started;
  }

  async stopPreview(
    actor: Actor,
    selector: { previewId?: string; projectId?: string },
  ): Promise<{ stopped: number }> {
    const previews = this.need(this.deps.previews, "previews");
    if (!selector.previewId && !selector.projectId) {
      throw new Error("give previewId or projectId: stopping every preview is not a default");
    }
    return previews.stop(selector, `stopped from ${actor}`);
  }

  listPreviews(projectId?: string): { previews: PreviewView[]; pool: string } {
    const previews = this.need(this.deps.previews, "previews");
    return {
      previews: previews.list(projectId),
      pool: `${this.deps.config.previewPortFrom}-${this.deps.config.previewPortTo}`,
    };
  }

  /** The last lines of a preview's log: where a misconfiguration actually shows up (§21.3). */
  previewLog(previewId: string, lines?: number): Promise<string[]> {
    return this.need(this.deps.previews, "previews").log(previewId, lines);
  }

  /** The engines, models and reasoning levels a launch or a profile may name (AP-08, AP-09). */
  modelCatalog(): ReturnType<typeof modelCatalog> {
    return modelCatalog();
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
  /**
   * Leave a note for a run that is already going (SR-09, §6.8).
   *
   * Two deliveries, one row. The note is appended to `.lightsout/inbox.md` for an agent that
   * reads it mid-turn, and it stays pending until something takes it — the runner hands over
   * whatever is left at the end of the turn, so the run cannot finish without it.
   *
   * It is not an answer to a doubt and it grants nothing: a run waiting on a person is waiting on
   * `answer_doubt`, and the note is delivered when it is running again.
   */
  async steerRun(
    actor: Actor,
    input: { runId?: string; projectId?: string; note: string },
  ): Promise<{ runId: string; noteId: string; pending: number; inbox: string }> {
    const { repos, orchestrator } = this.deps;
    if (!input.note.trim()) throw new Error("a note cannot be empty: say what should change");

    const runId = input.runId ?? this.liveRunFor(input.projectId);
    const run = repos.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const task = repos.tasks.get(run.task_id);
    if (!task) throw new Error(`run ${runId} has no task`);
    if (run.status === "ok" || run.ended_at) {
      throw new Error(`run ${runId} has already finished; launch again with the correction in it`);
    }
    const project = this.project(task.project_id);

    const row = repos.runNotes.add({
      runId,
      projectId: project.id,
      note: input.note,
      createdBy: actor,
    });

    // The file the protocol tells every agent to read (MC-11). Appended, never rewritten: a
    // second note must not erase the first, and the agent may be reading it right now.
    const inbox = path.join(project.path, INBOX_REL);
    await mkdir(path.dirname(inbox), { recursive: true });
    await appendFile(
      inbox,
      `## ${row.created_at.slice(0, 19)}Z (${actor})\n\n${input.note.trim()}\n\n`,
      "utf8",
    );

    // The event is what puts it in the timeline and what keeps the run reconstructible from the
    // record (OB-02, OB-06); the SSE stream follows the event cursor, so the panel sees it.
    repos.events.append({
      runId,
      type: "run.steered",
      payload: { note: input.note.trim().slice(0, 400), actor, delivery: "inbox" },
    });

    return {
      runId,
      noteId: row.id,
      pending: repos.runNotes.countPending(runId),
      inbox,
    };
  }

  /** The run in flight for a project, however the caller named it (SR-09, §5.4). */
  private liveRunFor(projectId?: string): string {
    const { repos, orchestrator } = this.deps;
    if (!projectId) throw new Error("give runId or projectId");
    const live = orchestrator.live.forProject(projectId)[0];
    if (live) return live.runId;
    const found = repos.runs
      .listActive()
      .find((run) => repos.tasks.get(run.task_id)?.project_id === projectId);
    if (!found) throw new Error(`no run in flight for project ${projectId}`);
    return found.id;
  }

  // --- Triggers: launches with a clock on them (TR-01..07, §16b) -------------

  /**
   * Create a trigger. Everything that can be wrong is wrong now rather than at 07:00 on a Sunday:
   * the cron parses, the target exists and is repeatable, the agent is launchable.
   *
   * A project with a trigger is unattended (TR-07). Work that starts when nobody is there must not
   * stop a minute later waiting for a permission someone would have granted.
   */
  createTrigger(
    actor: Actor,
    input: {
      projectId: string;
      name: string;
      cron: string;
      phase?: string;
      agentId?: string;
      title?: string;
      request: string;
      expects: string;
      enabled?: boolean;
    },
  ): TriggerRow & { nextFireAt: string | null; unattendedTurnedOn: boolean } {
    const project = this.project(input.projectId);
    this.requireNotArchived(project.id);
    const fields = parseCron(input.cron); // throws with the field that is wrong
    if (!input.request.trim() || !input.expects.trim()) {
      throw new Error("a trigger states its request and what it expects back, like any launch (OR-10)");
    }
    if ((input.phase ? 1 : 0) + (input.agentId ? 1 : 0) !== 1) {
      throw new Error("a trigger fires either a phase or a task with an agent, not both and not neither");
    }

    if (input.phase) {
      const phases = this.need(this.deps.phases, "phases");
      const row = phases.list(project.id).find((p) => p.phase_id === input.phase || p.id === input.phase);
      if (!row) throw new Error(`unknown phase: ${input.phase}`);
      if (!row.repeatable) {
        throw new Error(
          `phase ${row.phase_id} is not repeatable, so it can only run once: a trigger needs a ` +
            "phase that may run again (TP-07)",
        );
      }
    } else {
      this.requireLaunchable(input.agentId!);
    }

    let unattendedTurnedOn = false;
    if (!project.unattended) {
      this.deps.repos.projects.update(project.id, { unattended: true });
      unattendedTurnedOn = true;
    }

    const row = this.deps.repos.triggers.create({
      projectId: project.id,
      name: input.name,
      cron: fields.expression,
      ...(input.phase ? { phaseRef: input.phase } : { agentId: input.agentId }),
      ...(input.title ? { title: input.title } : {}),
      request: input.request,
      expects: input.expects,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      createdBy: actor,
    });
    this.changed("trigger", row.id, actor);
    return { ...row, nextFireAt: nextFire(fields, new Date())?.toISOString() ?? null, unattendedTurnedOn };
  }

  updateTrigger(
    actor: Actor,
    triggerId: string,
    patch: {
      name?: string;
      cron?: string;
      request?: string;
      expects?: string;
      title?: string;
      enabled?: boolean;
    },
  ): TriggerRow & { nextFireAt: string | null } {
    const current = this.deps.repos.triggers.getOrThrow(triggerId);
    if (patch.cron !== undefined) parseCron(patch.cron);
    const row = this.deps.repos.triggers.update(current.id, patch);
    this.changed("trigger", row.id, actor);
    return {
      ...row,
      nextFireAt: (() => {
        try {
          return nextFire(parseCron(row.cron), new Date())?.toISOString() ?? null;
        } catch {
          return null;
        }
      })(),
    };
  }

  deleteTrigger(actor: Actor, triggerId: string): { deleted: boolean } {
    const row = this.deps.repos.triggers.getOrThrow(triggerId);
    const deleted = this.deps.repos.triggers.remove(row.id);
    this.changed("trigger", row.id, actor, "delete");
    return { deleted };
  }

  /** Every trigger with the next time it would fire, and what happened last time (TR-05, TR-06). */
  listTriggers(projectId?: string): (TriggerRow & { nextFireAt: string | null; cronReads: string })[] {
    return this.deps.repos.triggers.list(projectId).map((row) => {
      try {
        const fields = parseCron(row.cron);
        return {
          ...row,
          nextFireAt: row.enabled ? (nextFire(fields, new Date())?.toISOString() ?? null) : null,
          cronReads: describeCron(row.cron),
        };
      } catch (err) {
        return {
          ...row,
          nextFireAt: null,
          cronReads: `invalid: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
  }

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

  // --- Writing a document without destroying it (MC-12..14, DESIGN §9.2b) ----

  /** The three writing verbs share this: the file, the guard, the snapshot and the event. */
  private docFile(project: ProjectRow, doc: DocName): string {
    return path.join(project.path, "doc", `${doc}.md`);
  }

  private requireNoActiveRun(project: ProjectRow): void {
    // A run rewrites these files as it goes; a write underneath it would be lost or would
    // clobber the agent's own edit (MC-04).
    if (activeRunFor({ config: this.deps.config, repos: this.deps.repos }, project.id)) {
      throw new Error(`a run is active on ${project.id}; try again when it finishes`);
    }
  }

  private async currentDoc(project: ProjectRow, doc: DocName): Promise<string> {
    try {
      return await readFile(this.docFile(project, doc), "utf8");
    } catch {
      return "";
    }
  }

  private async commitDoc(
    actor: Actor,
    project: ProjectRow,
    doc: DocName,
    content: string,
    how: "replace" | "append" | "patch",
    snapshot: string | null,
  ): Promise<{ written: true; doc: DocName; hash: string; snapshot: string | null }> {
    await writeFile(this.docFile(project, doc), content, "utf8");
    this.deps.repos.events.append({
      type: "system",
      payload: {
        reason: "doc written",
        projectId: project.id,
        doc,
        how,
        bytes: Buffer.byteLength(content, "utf8"),
        snapshot: snapshot ? path.basename(snapshot) : null,
        actor,
      },
    });
    return { written: true, doc, hash: hashContent(content), snapshot };
  }

  /**
   * Replace a document whole. Refused on the append-only ones, and refused when `baseHash` names
   * a version that is no longer current: a caller who has not read the file has no business
   * replacing it (MC-12, MC-14).
   */
  async writeDoc(
    actor: Actor,
    projectId: string,
    doc: DocName,
    content: string,
    opts: { baseHash?: string } = {},
  ): Promise<{ written: true; doc: DocName; hash: string; snapshot: string | null }> {
    const project = this.project(projectId);
    this.requireNoActiveRun(project);

    if (APPEND_ONLY_DOCS.includes(doc)) {
      throw new Error(
        `${doc}.md is append-only (§8.3): the system adds to it from the database and a ` +
          "replacement destroys entries nobody can get back. Use append_doc, or patch_doc to " +
          "correct an entry in place.",
      );
    }

    if (opts.baseHash) {
      const currentHash = hashContent(await this.currentDoc(project, doc));
      if (currentHash !== opts.baseHash) {
        throw new Error(
          `${doc}.md changed since you read it (current hash ${currentHash.slice(0, 12)}); ` +
            "read it again before writing.",
        );
      }
    }

    const snapshot = await snapshotFile(
      this.docFile(project, doc),
      docHistoryDir(project.path),
      doc,
    );
    return this.commitDoc(actor, project, doc, content, "replace", snapshot);
  }

  /** Add to the end of a document. The only writing verb allowed on DECISIONS and QUESTIONS. */
  async appendDoc(
    actor: Actor,
    projectId: string,
    doc: DocName,
    content: string,
  ): Promise<{ written: true; doc: DocName; hash: string; snapshot: string | null }> {
    const project = this.project(projectId);
    this.requireNoActiveRun(project);
    const current = await this.currentDoc(project, doc);
    // One blank line between what was there and what arrives; nothing is rewritten, so there is
    // nothing to snapshot.
    const next = current.trim() ? `${current.trimEnd()}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    return this.commitDoc(actor, project, doc, next, "append", null);
  }

  /** Exact-string edits, all or nothing (MC-13). Ambiguity is refused, not resolved. */
  async patchDoc(
    actor: Actor,
    projectId: string,
    doc: DocName,
    edits: DocEdit[],
  ): Promise<{
    written: true;
    doc: DocName;
    hash: string;
    snapshot: string | null;
    applied: number;
  }> {
    const project = this.project(projectId);
    this.requireNoActiveRun(project);
    const current = await this.currentDoc(project, doc);
    if (!current) throw new Error(`${doc}.md does not exist in ${project.id}`);

    const { content, applied } = applyEdits(current, edits);
    const snapshot = await snapshotFile(
      this.docFile(project, doc),
      docHistoryDir(project.path),
      doc,
    );
    const result = await this.commitDoc(actor, project, doc, content, "patch", snapshot);
    return { ...result, applied };
  }

  async readDoc(
    projectId: string,
    doc: DocName,
  ): Promise<{ content: string; path: string; hash: string }> {
    const project = this.project(projectId);
    const file = this.docFile(project, doc);
    try {
      const content = await readFile(file, "utf8");
      // The hash goes back with the content so a caller can hand it to `write_doc` (MC-14).
      return { content, path: file, hash: hashContent(content) };
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
      /** `read` or `write` (PE-09 amended). Reported everywhere areas are: a grant whose extent
       *  is invisible on a surface has not been reviewed by whoever is looking at that surface. */
      access: AreaAccess;
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
          access: (row.access ?? "read") as AreaAccess,
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
   * Declare a directory of the workspace this project may reach (PE-09). `access` is `read` by
   * default — the narrower grant — and `write` when someone chose it deliberately.
   *
   * Every rule about what cannot be an area at all lives in `validateArea`, so both surfaces
   * refuse the same things for the same stated reason, and `write` widens nothing there: the
   * workspace root, agents/, templates/, vault.yaml, knowledge/ and another project are refused
   * before access is even looked at.
   */
  addArea(
    actor: Actor,
    projectId: string,
    input: { path: string; access?: AreaAccess; note?: string },
  ): {
    projectId: string;
    path: string;
    access: AreaAccess;
    absolute: string;
    hostPath: string | null;
  } {
    const project = this.project(projectId);
    const { config } = this.deps;
    const target = validateArea(config.workspace, project.path, input.path);
    const access: AreaAccess = input.access === "write" ? "write" : "read";
    this.deps.repos.areas.add({
      projectId: project.id,
      path: target.relative,
      access,
      ...(input.note ? { note: input.note } : {}),
      addedBy: actor,
    });
    this.deps.repos.events.append({
      type: "config.changed",
      payload: {
        kind: "area",
        id: `${project.id}:${target.relative}`,
        op: "add",
        access,
        actor,
      },
    });
    return {
      projectId: project.id,
      path: target.relative,
      access,
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

  /**
   * Turn unattended execution on or off for a project (OR-12, §7.7).
   *
   * On — the default — a `require_human` verdict off the hard floor is settled by the judge or
   * the advisor, or refused with its reason, and the run keeps going. Off, it opens a doubt and
   * waits, which is the older behaviour and the right one when somebody is watching on purpose.
   */
  setProjectUnattended(
    actor: Actor,
    projectId: string,
    unattended: boolean,
  ): { projectId: string; unattended: boolean } {
    const project = this.project(projectId);
    const updated = this.deps.repos.projects.update(project.id, { unattended });
    this.deps.repos.events.append({
      type: "config.changed",
      payload: { kind: "project", id: project.id, op: "unattended", value: unattended, actor },
    });
    return { projectId: updated.id, unattended: updated.unattended === 1 };
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
      // Outside the base's own folder: a linked base belongs to the user (KB-08, §9.2b).
      { historyDir: knowledgeHistoryDir(this.deps.config.workspace, baseId) },
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
  /** The ids of every loaded base, so a caller can derive one that is free (KB-12). */
  knowledgeIds(): string[] {
    return (this.deps.knowledge?.list() ?? []).map((base) => base.manifest.id);
  }

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
  /**
   * A new entry, identified by its label; the id is derived and returned (VT-08). Separate from
   * `writeVaultEntry` because creating and editing differ in exactly this: an edit must never
   * rename the id, which is already inside an environment variable someone's script reads.
   */
  async createVaultEntry(
    actor: Actor,
    input: Partial<Omit<VaultEntry, "id" | "fields">> & {
      label: string;
      fields?: Record<string, string | null>;
    },
  ): Promise<VaultEntryView> {
    const vault = this.need(this.deps.vault, "vault");
    const entryId = await vault.idForLabel(input.label);
    const view = await vault.put(entryId, input);
    this.changed("vault", entryId, actor);
    return view;
  }

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
