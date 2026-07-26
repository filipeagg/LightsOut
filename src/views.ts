/**
 * Read-model shaping shared by the MCP tools and the HTTP read API (DESIGN §10.2, §12.1).
 *
 * The panel and Claude Desktop are two skins over the same system (§12.0). Mutations share
 * that guarantee through the actions module; reads share it here. A second copy of "what a
 * doubt looks like on screen" would drift within a phase, and the panel's renderers are written
 * against these exact shapes.
 *
 * Everything in this file is SELECT-only (OB-01).
 */
import type { Config } from "./config.js";
import type { Repos } from "./db/repos/index.js";
import type { ChainRow, DoubtRow, ProjectRow, RunRow } from "./db/types.js";
import type { EngineHealth } from "./health.js";

export type ViewDeps = { config: Config; repos: Repos };

export function ageMinutes(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

export function secondsSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 1000);
}

/** Shape a doubt for a decision: options as buttons, second opinion visible (MC-03, DO-05). */
export function doubtView(deps: ViewDeps, doubt: DoubtRow) {
  const task = deps.repos.tasks.get(doubt.task_id);
  return {
    id: doubt.id,
    ref: doubt.ref,
    projectId: doubt.project_id,
    taskTitle: task?.title ?? "",
    kind: doubt.kind,
    status: doubt.status,
    context: doubt.context,
    blocks: doubt.blocks,
    options: deps.repos.doubts.options(doubt),
    recommendation: doubt.recommendation,
    secondOpinion: deps.repos.doubts.secondOpinion(doubt),
    ageMin: ageMinutes(doubt.created_at),
  };
}

export function activeRunFor(deps: ViewDeps, projectId: string): RunRow | undefined {
  return deps.repos.runs
    .listActive()
    .find((run) => deps.repos.tasks.get(run.task_id)?.project_id === projectId);
}

/** The run card of WP-05: elapsed against the timeout, inactivity against the last action. */
export function runView(deps: ViewDeps, run: RunRow, project: ProjectRow) {
  const task = deps.repos.tasks.get(run.task_id);
  const last = deps.repos.events.lastAction(run.id);
  const timeoutMin =
    task?.level === "quick" ? deps.config.timeoutQuickMin : deps.config.timeoutFullMin;
  return {
    id: run.id,
    taskId: run.task_id,
    taskTitle: task?.title ?? "",
    agentId: task?.agent_id ?? null,
    status: run.status,
    engine: run.engine,
    model: run.model,
    elapsedS: secondsSince(run.started_at),
    inactivityS: last ? secondsSince(last.ts) : secondsSince(run.started_at),
    lastAction: last ? { type: last.type, payload: JSON.parse(last.payload) } : null,
    timeoutS: timeoutMin * 60,
    inactivityLimitS: deps.config.inactivityMin * 60,
    projectId: project.id,
    projectName: project.name,
  };
}

export function chainView(deps: ViewDeps, chain: ChainRow) {
  return {
    id: chain.id,
    title: chain.title,
    status: chain.status,
    tasks: deps.repos.tasks.listByChain(chain.id).map((t) => ({
      id: t.id,
      position: t.position,
      title: t.title,
      status: t.status,
      agentId: t.agent_id,
    })),
  };
}

/** Everything about one project in a single read (MC-06, WP-04). */
export function projectStatusView(deps: ViewDeps, project: ProjectRow) {
  const { repos } = deps;
  const chain =
    repos.chains.activeForProject(project.id) ?? repos.chains.listByProject(project.id)[0];
  const run = activeRunFor(deps, project.id);
  const decision = repos.decisions.latest(project.id);
  const open = repos.doubts.listOpen(project.id);
  const next = chain ? repos.tasks.nextQueued(chain.id) : undefined;
  const tasks = chain ? repos.tasks.listByChain(chain.id) : [];
  const doneCount = tasks.filter((t) => t.status === "ok").length;
  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      pushPolicy: project.push_policy,
      verifyCmd: project.verify_cmd,
      remote: project.repo_remote,
      archived: project.archived === 1,
    },
    chain: chain ? chainView(deps, chain) : null,
    run: run ? runView(deps, run, project) : null,
    doubts: open.map((d) => doubtView(deps, d)),
    state: {
      phase: chain
        ? `chain "${chain.title}" ${doneCount}/${tasks.length} (${chain.status})`
        : "no chain",
      lastDecision: decision
        ? { kind: decision.kind, choice: decision.choice, at: decision.created_at }
        : null,
      next: next ? next.title : null,
    },
  };
}

/** One row of the project list (WP-10). */
export function projectListItem(deps: ViewDeps, project: ProjectRow) {
  const { repos } = deps;
  // Fall back to the most recent chain: a project whose chain finished still has progress worth
  // showing, and a row reading "no chain" the moment the work succeeds is just wrong (WP-10).
  const chain =
    repos.chains.activeForProject(project.id) ?? repos.chains.listByProject(project.id)[0];
  const run = activeRunFor(deps, project.id);
  const history = repos.runs.history({ projectId: project.id, limit: 1 });
  const tasks = chain ? repos.tasks.listByChain(chain.id) : [];
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    status: chain?.status ?? "idle",
    // Phases arrive in phase 9 (TP-06); until then the chain's tasks are what the bar shows.
    template: null as string | null,
    phases: null as null | { done: number; total: number },
    chain: chain
      ? {
          id: chain.id,
          title: chain.title,
          status: chain.status,
          steps: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        }
      : null,
    activeRun: run ? { id: run.id, status: run.status } : null,
    openDoubts: repos.doubts.listOpen(project.id).length,
    lastActivity: history[0]?.started_at ?? project.created_at,
    archived: project.archived === 1,
  };
}

/**
 * The global view (WP-04): what needs a human first, then what is running, then the engines.
 * The attention items are derived here so the panel and any other surface agree on what
 * "needs attention" means (OB-03).
 */
export function overviewView(
  deps: ViewDeps,
  engines: EngineHealth[],
  opts: { includeArchived?: boolean } = {},
) {
  const { repos } = deps;
  // Archived projects are off the list by default (PM-08) but must stay reachable, or
  // unarchiving from the panel would mean guessing a URL.
  const projects = repos.projects.list({ includeArchived: opts.includeArchived ?? false });
  const items = projects.map((p) => projectListItem(deps, p));
  const doubts = repos.doubts.list({ status: "open" }).map((d) => doubtView(deps, d));
  const activeRuns = repos.runs
    .listActive()
    .map((run) => {
      const task = repos.tasks.get(run.task_id);
      const project = task ? repos.projects.get(task.project_id) : undefined;
      return project ? runView(deps, run, project) : null;
    })
    .filter((view): view is ReturnType<typeof runView> => view !== null);

  const attention = [
    ...doubts.map((d) => ({
      kind: "doubt" as const,
      projectId: d.projectId,
      ref: d.ref,
      title: d.taskTitle || d.ref,
      detail: d.context,
      ageMin: d.ageMin,
      severity: d.kind === "permission" ? ("amber" as const) : ("amber" as const),
    })),
    ...items
      .filter((p) => p.status === "paused")
      .map((p) => ({
        kind: "paused" as const,
        projectId: p.id,
        ref: p.chain?.id ?? p.id,
        title: p.name,
        detail: `chain "${p.chain?.title ?? ""}" is paused`,
        ageMin: ageMinutes(p.lastActivity),
        severity: "red" as const,
      })),
    ...engines
      .filter((e) => !e.detected || !e.auth)
      .map((e) => ({
        kind: "engine" as const,
        projectId: null,
        ref: e.engine,
        title: `${e.engine} is not ${e.detected ? "authenticated" : "installed"}`,
        detail: !e.detected
          ? `The adapter ${e.adapter} is not on PATH.`
          : e.authError
            ? `A run failed on it: ${e.authError}. Reconnect it from the setup page.`
            : "Reconnect it from the setup page.",
        ageMin: 0,
        severity: "red" as const,
      })),
  ].sort((a, b) => b.ageMin - a.ageMin);

  return {
    counts: {
      projects: items.length,
      activeRuns: activeRuns.length,
      openDoubts: doubts.length,
      paused: items.filter((p) => p.status === "paused").length,
    },
    attention,
    projects: items,
    activeRuns,
    doubts,
    engines: engines.map((e) => ({
      engine: e.engine,
      adapter: e.adapter,
      detected: e.detected,
      auth: e.auth,
      authSource: e.authSource,
      authError: e.authError ?? null,
      checkedAt: e.checkedAt,
    })),
    network: deps.config.egress,
  };
}
