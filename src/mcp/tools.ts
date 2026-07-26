/**
 * The MCP tool set (MC-02, DESIGN §10.2).
 *
 * Every tool is a thin wrapper over the orchestrator, the doubt service and the repos: no
 * business logic lives here, so the CLI, the panel and MCP can never disagree about what
 * happened. Launches return immediately (MC-06) and `project_status` is the polling primitive.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { HealthProbe } from "../health.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { DoubtService } from "../orchestrator/doubts.js";
import type { PhaseService } from "../orchestrator/phases.js";
import type { TemplatesLoader } from "../templates/loader.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { Vault } from "../vault/vault.js";
import type { ProjectRow } from "../db/types.js";
import type { Actions } from "../control/actions.js";
import { askEngine } from "../acp/advisor.js";
import { guide, TOPIC_ORDER } from "./guide.js";
import { CAPABILITIES } from "../policy/capabilities.js";
import { modelCatalog } from "../agents/effective.js";
import { ENGINE_IDS, REASONING_LEVELS } from "../agents/models.js";
import { TOOLCHAIN_MANAGERS } from "../projects/toolchain.js";
import { conflict, failure, invalid, notFound, success, toolResult } from "./envelope.js";
// One read model for both surfaces: the panel renders these exact shapes (DESIGN §12.0).
import { activeRunFor, doubtView, projectListItem, projectStatusView } from "../views.js";

export type McpDeps = {
  config: Config;
  repos: Repos;
  agents: AgentsLoader;
  health: HealthProbe;
  orchestrator: Orchestrator;
  doubts: DoubtService;
  /** Every mutation goes through here, with actor='mcp' (§12.0). */
  actions: Actions;
  /** Phase 9 material. Optional so a process without it still serves the phase 6 tools. */
  templates?: TemplatesLoader;
  knowledge?: KnowledgeLoader;
  vault?: Vault;
  phases?: PhaseService;
  version: string;
};

const DOC_NAMES = ["STATE", "PLAN", "DECISIONS", "QUESTIONS"] as const;
const levelSchema = z.enum(["quick", "full"]);

/**
 * What a launch may say about the engine and the model (AP-09). Spread into every launch schema so
 * the three tools cannot drift. All optional: omitted means the agent profile decides. The model
 * is a plain string rather than an enum because the accepted set depends on the engine, and
 * `list_agents` publishes it — an invalid one is refused with the list, not silently accepted.
 */
const modelChoiceSchema = {
  engine: z
    .enum(ENGINE_IDS as unknown as [string, ...string[]])
    .optional()
    .describe("Run on this engine instead of the profile's, for this launch only."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe("Model for this launch only; one of those `list_agents` reports for the engine."),
  reasoning: z.enum(REASONING_LEVELS).optional(),
};

function docPath(project: ProjectRow, doc: string): string {
  return path.join(project.path, "doc", `${doc}.md`);
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const { repos, orchestrator, agents, doubts, actions } = deps;

  const project = (id: string): ProjectRow => {
    const row = repos.projects.get(id);
    if (!row) throw notFound(`project not found: ${id}`);
    return row;
  };

  /** Wrap a handler so every failure comes back as an envelope, never as a protocol error. */
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
  ) => {
    server.registerTool(name, { description, inputSchema }, (async (args: unknown) => {
      try {
        const payload = await handler(args as z.infer<z.ZodObject<S>>);
        return toolResult(success(payload));
      } catch (err) {
        return toolResult(failure(err));
      }
    }) as never);
  };

  tool("health", "System health: database, engines, network mode and active runs (RT-06).", {}, async () => {
    const db = (() => {
      try {
        repos.settings.all();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })();
    const engines = await deps.health.engines();
    return {
      db,
      engines: Object.fromEntries(
        engines.map((e) => [e.engine, { installed: e.detected, auth: e.auth, authSource: e.authSource }]),
      ),
      network: deps.config.egress,
      activeRuns: orchestrator.activeRuns,
      // MC-08: both paths, always, so nobody has to guess the mapping.
      workspace: {
        container: deps.config.workspace,
        host: deps.config.workspaceHost || null,
      },
      version: deps.version,
    };
  });

  tool(
    "guide",
    "How this system works, so you can use it without reading its repository (MC-09). Call with " +
      "no topic for the list; with one for that section whole. Start at 'overview'. Sections: " +
      `${TOPIC_ORDER.join(", ")}.`,
    { topic: z.string().optional() },
    async ({ topic }) => {
      try {
        return guide(topic) as unknown as Record<string, unknown>;
      } catch (err) {
        throw invalid(err instanceof Error ? err.message : String(err));
      }
    },
  );

  tool(
    "list_projects",
    "All projects with their active run and open doubt counts.",
    { archived: z.boolean().optional() },
    async ({ archived }) => ({
      projects: repos.projects
        .list({ includeArchived: archived ?? false })
        .map((p) => projectListItem(deps, p)),
    }),
  );

  tool(
    "create_project",
    "Scaffold a project: doc/ scaffold, lightsout.yaml, git init and the initial commit (PM-01). " +
      "With a template it also materialises the phases and attaches the knowledge bases (TP-05, KB-03).",
    {
      name: z.string().min(1),
      /** PM-09: required whatever the template. */
      context: z
        .string()
        .min(1)
        .describe(
          "What this project is for, in a few lines: goal, actors, systems involved, " +
            "constraints, definition of done, what is out of scope. Required (PM-09); it is " +
            "injected into every run's prompt.",
        ),
      remote: z.string().optional(),
      verify: z.string().optional(),
      push: z.enum(["auto", "manual", "never"]).optional(),
      defaultAgent: z.string().optional(),
      template: z.string().optional(),
      knowledge: z.array(z.string().min(1)).optional(),
      writableKnowledge: z.string().optional(),
    },
    async (args) => {
      const result = await actions.createProject("mcp", {
        name: args.name,
        context: args.context,
        ...(args.remote !== undefined ? { remote: args.remote } : {}),
        ...(args.verify !== undefined ? { verify: args.verify } : {}),
        ...(args.push !== undefined ? { push: args.push } : {}),
        ...(args.defaultAgent !== undefined ? { defaultAgent: args.defaultAgent } : {}),
        ...(args.template !== undefined ? { template: args.template } : {}),
        ...(args.knowledge !== undefined ? { knowledge: args.knowledge } : {}),
        ...(args.writableKnowledge !== undefined
          ? { writableKnowledge: args.writableKnowledge }
          : {}),
      });
      return {
        project: { id: result.project.id, path: result.project.path },
        created: result.created,
        phases: result.phases,
        knowledge: result.knowledge,
      };
    },
  );

  tool(
    "project_status",
    "Everything about one project in a single call: chain, current run, doubts and state (MC-06).",
    { projectId: z.string().min(1) },
    async ({ projectId }) => projectStatusView(deps, project(projectId)),
  );

  tool(
    "archive_project",
    "Archive a project: it drops out of the lists and refuses new launches, but nothing is " +
      "removed. Reversible — call it again with archived=false (PM-08).",
    { projectId: z.string().min(1), archived: z.boolean().optional() },
    async ({ projectId, archived }) => {
      const row = actions.archiveProject("mcp", projectId, archived ?? true);
      return { project: { id: row.id, archived: row.archived === 1 } };
    },
  );

  tool(
    "delete_project",
    "Delete a project for good: its rows and, unless keepFiles is set, its folder in the " +
      "workspace. Irreversible, refused while a run is active, and `confirm` must be the " +
      "project id (PM-08).",
    {
      projectId: z.string().min(1),
      confirm: z.string().min(1),
      keepFiles: z.boolean().optional(),
    },
    async ({ projectId, confirm, keepFiles }) =>
      actions.deleteProject("mcp", projectId, {
        confirm,
        ...(keepFiles !== undefined ? { keepFiles } : {}),
      }),
  );

  tool(
    "list_agents",
    "Agent profiles, valid and rejected (AP-02), plus the engines and models a launch may " +
      "choose from (AP-09). A profile's engine and model are its default: launch_task, " +
      "launch_chain and launch_phase accept engine/model/reasoning to override them for one run.",
    {},
    async () => {
    const snapshot = agents.current();
    return {
      // AP-09: what a launch may pass. Without this the client has to guess, and a guess is a
      // refusal rather than a run.
      models: modelCatalog(),
      reasoning: [...REASONING_LEVELS],
      agents: [
        ...[...snapshot.profiles.values()].map((p) => ({
          id: p.id,
          name: p.name,
          engine: p.engine,
          model: p.model ?? null,
          reasoning: p.reasoning ?? null,
          policy: p.policy,
          advisor: p.advisor,
          valid: true,
        })),
        ...snapshot.rejected.map((r) => ({
          id: r.file.replace(/\.(ya?ml)$/i, ""),
          name: r.file,
          engine: null,
          model: null,
          valid: false,
          error: r.error,
        })),
      ],
      packs: [...snapshot.packs.keys()],
    };
    },
  );

  tool("reload_agents", "Re-read profiles and policy packs from the workspace (AP-03).", {}, async () => {
    const report = await actions.reloadAgents("mcp");
    return { ...report, rejected: agents.current().rejected };
  });

  tool(
    "launch_chain",
    "Queue a chain of tasks and start it if the project is free. Returns immediately (MC-06). " +
      "Every task states its spec AND what it must give back (`expects`) — OR-10. Each task may " +
      "also choose its own engine/model, so the mechanical steps can run cheap (AP-09).",
    {
      projectId: z.string().min(1),
      title: z.string().min(1),
      tasks: z
        .array(
          z.object({
            title: z.string().min(1),
            spec: z.string().min(1),
            expects: z
              .string()
              .min(1)
              .describe("What comes back: the artefact, its shape, and how you decide it was met."),
            agentId: z.string().min(1),
            level: levelSchema.optional(),
            verify: z.string().optional(),
            needs: z.array(z.enum(CAPABILITIES)).optional(),
            grants: z.array(z.enum(CAPABILITIES)).optional(),
            ...modelChoiceSchema,
          }),
        )
        .min(1),
    },
    async (args) => {
      const launch = await actions.launchChain("mcp", {
        projectId: args.projectId,
        title: args.title,
        tasks: args.tasks.map((t) => ({
          title: t.title,
          spec: t.spec,
          expects: t.expects,
          agentId: t.agentId,
          ...(t.level ? { level: t.level } : {}),
          ...(t.verify !== undefined ? { verifyCmd: t.verify } : {}),
          ...(t.needs?.length ? { needs: t.needs } : {}),
          ...(t.grants?.length ? { grants: t.grants } : {}),
          ...(t.engine ? { engine: t.engine } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(t.reasoning ? { reasoning: t.reasoning } : {}),
        })),
      });
      return launch as unknown as Record<string, unknown>;
    },
  );

  tool(
    "launch_task",
    "Queue one task, appending to a chain when given. Returns immediately (MC-06). State the " +
      "request in `spec` and what must come back in `expects` — both required (OR-10).",
    {
      projectId: z.string().min(1),
      title: z.string().min(1),
      spec: z.string().min(1).describe("What you are asking for, this time, in your words."),
      expects: z
        .string()
        .min(1)
        .describe(
          "What comes back: the artefact, its shape, and the criterion that decides it was met. " +
            "Not the same as a phase's deliverable, which is a path checked on disk.",
        ),
      agentId: z.string().min(1),
      needs: z
        .array(z.enum(CAPABILITIES))
        .optional()
        .describe(
          "What this task needs to succeed: network, deps_install, execute, write, git, delete, " +
            "knowledge_write. Checked against the agent's policy before the run starts, so a " +
            "mismatch is a refusal in one second rather than a wasted run (PE-12).",
        ),
      grants: z
        .array(z.enum(CAPABILITIES))
        .optional()
        .describe("Grant these for this run only. Recorded on the task; gone when it ends."),
      level: levelSchema.optional(),
      verify: z.string().optional(),
      chainId: z.string().optional(),
      ...modelChoiceSchema,
    },
    async (args) =>
      actions.launchTask("mcp", {
        ...(args.needs?.length ? { needs: args.needs } : {}),
        ...(args.grants?.length ? { grants: args.grants } : {}),
        projectId: args.projectId,
        title: args.title,
        spec: args.spec,
        expects: args.expects,
        agentId: args.agentId,
        ...(args.level ? { level: args.level } : {}),
        ...(args.verify !== undefined ? { verifyCmd: args.verify } : {}),
        ...(args.chainId ? { chainId: args.chainId } : {}),
        ...(args.engine ? { engine: args.engine } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.reasoning ? { reasoning: args.reasoning } : {}),
      }),
  );

  tool(
    "abort_run",
    "Abort a chain: drop its queued tasks AND stop the run in flight — the ACP turn is cancelled " +
      "and the adapter process ends (OR-06, OR-09). Pass letCurrentFinish to leave the running " +
      "agent working and only drop the queue.",
    {
      runId: z.string().optional(),
      chainId: z.string().optional(),
      letCurrentFinish: z.boolean().optional(),
    },
    async ({ runId, chainId, letCurrentFinish }) => {
      if (!runId && !chainId) throw invalid("give runId or chainId");
      return actions.abortRun("mcp", {
        ...(runId ? { runId } : {}),
        ...(chainId ? { chainId } : {}),
        ...(letCurrentFinish ? { letCurrentFinish: true } : {}),
      });
    },
  );

  tool(
    "stop_run",
    "Stop the run executing right now: cancel the ACP turn, end the adapter process, release any " +
      "permission gate it was holding, and pause the chain. The queue is left alone (OR-09).",
    { runId: z.string().optional(), projectId: z.string().optional() },
    async ({ runId, projectId }) => {
      if (!runId && !projectId) throw invalid("give runId or projectId");
      return actions.stopRun("mcp", {
        ...(runId ? { runId } : {}),
        ...(projectId ? { projectId } : {}),
      });
    },
  );

  tool(
    "resume_chain",
    "Put a paused or interrupted chain back to work, queueing the tasks that did not finish (OR-05).",
    { projectId: z.string().optional(), chainId: z.string().optional() },
    async ({ projectId, chainId }) => {
      if (!projectId && !chainId) throw invalid("give projectId or chainId");
      return actions.resumeChain("mcp", {
        ...(projectId ? { projectId } : {}),
        ...(chainId ? { chainId } : {}),
      });
    },
  );

  tool(
    "list_doubts",
    "Open doubts with their options, so they can be answered as buttons (DO-05, MC-03).",
    { projectId: z.string().optional(), status: z.enum(["open", "answered", "closed"]).optional() },
    async ({ projectId, status }) => ({
      doubts: repos.doubts
        .list({
          ...(projectId ? { projectId } : {}),
          ...(status ? { status } : { status: "open" as const }),
        })
        .map((d) => doubtView(deps, d)),
    }),
  );

  tool(
    "answer_doubt",
    "Answer an open doubt by option id; the task resumes with the decision recorded (DO-04).",
    {
      doubtId: z.string().min(1),
      choice: z.string().min(1),
      note: z.string().optional(),
      projectId: z.string().optional(),
    },
    async (args) =>
      actions.answerDoubt("mcp", {
        doubtId: args.doubtId,
        choice: args.choice,
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      }),
  );

  tool(
    "get_history",
    "Past runs with duration, cost when reported, and totals (OB-05).",
    {
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      before: z.string().optional(),
    },
    async (args) => {
      const runs = repos.runs.history({
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.before ? { before: args.before } : {}),
      });
      const byStatus: Record<string, number> = {};
      let costUsd = 0;
      for (const run of runs) {
        byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
        costUsd += run.cost_usd ?? 0;
      }
      return {
        runs: runs.map((r) => ({
          id: r.id,
          task: repos.tasks.get(r.task_id)?.title ?? "",
          engine: r.engine,
          model: r.model,
          status: r.status,
          startedAt: r.started_at,
          durationS: r.ended_at
            ? Math.round(
                (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000,
              )
            : null,
          costUsd: r.cost_usd,
          summary: r.summary,
        })),
        totals: { byStatus, costUsd: costUsd || null },
      };
    },
  );

  tool(
    "read_doc",
    "Read one of the project's managed documents.",
    { projectId: z.string().min(1), doc: z.enum(DOC_NAMES) },
    async ({ projectId, doc }) => {
      try {
        return { ...(await actions.readDoc(projectId, doc)), doc };
      } catch (err) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
    },
  );

  tool(
    "status_card",
    "The state of a project as one compact block, for showing a person without sending them to " +
      "the panel (MC-10). A snapshot: this client does not render live views pushed from a " +
      "server, so ask again to refresh.",
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      const row = project(projectId);
      const status = projectStatusView(deps, row);
      const docs = await actions.listDocs(row.id).catch(() => ({ docs: [] as never[] }));
      const steps = status.chain?.tasks ?? [];
      const done = steps.filter((s) => s.status === "ok").length;
      const current = steps.find((s) => s.status === "running");
      const recent = status.recent ?? [];
      const lines = [
        `LIGHTSOUT :: ${row.id}    ${new Date().toISOString().slice(0, 16)}Z`,
        `chain      ${status.chain ? `${done}/${steps.length}  ${status.chain.title}  ${status.chain.status}` : "none"}`,
        `run        ${
          status.run
            ? `${status.run.status}  ${status.run.engine}  ${status.run.taskTitle}`
            : status.lastRun
              ? `none — last ${status.lastRun.status}${status.lastRun.exitReason ? ` (${status.lastRun.exitReason.slice(0, 60)})` : ""}`
              : "none"
        }`,
        ...(current ? [`phase      ${current.title}`] : []),
        ...(recent.length
          ? [
              "",
              "last steps",
              ...recent.map((line) => `  ${line.at.slice(11, 16)}  ${line.text}`),
              "",
            ]
          : []),
        `doubts     ${
          status.doubts.length
            ? status.doubts.map((d) => `${d.ref} (${d.kind}, ${d.ageMin}m)`).join(", ")
            : "none"
        }`,
        `next       ${status.state.next ?? "nothing queued"}`,
        `docs       ${
          docs.docs.length
            ? docs.docs
                .slice(0, 4)
                .map((d) => `${d.path} ${(d.bytes / 1024).toFixed(1)}kB ${d.lint.ok ? "ok" : "drift"}`)
                .join(" · ")
            : "none"
        }`,
        `path       ${status.project.hostPath ?? row.path}`,
        ...(status.project.contextProvisional
          ? ["warning    the context brief is provisional; write a real one (PM-09)"]
          : []),
        `live view  http://127.0.0.1:8484/#/p/${row.id}`,
      ];
      return { card: lines.join("\n"), snapshotAt: new Date().toISOString() };
    },
  );

  tool(
    "list_docs",
    "Every Markdown file the project holds — deliverables included, not only the managed four — " +
      "with size, modification time, the machine-first verdict (BA-08) and where each file is on " +
      "this machine (PM-10).",
    { projectId: z.string().min(1) },
    async ({ projectId }) => actions.listDocs(projectId),
  );

  tool(
    "read_project_doc",
    "Read any Markdown file of the project by its relative path (PM-10). Confined to the project " +
      "directory; reports the container path and the local path on this machine.",
    { projectId: z.string().min(1), path: z.string().min(1) },
    async ({ projectId, path: relative }) => {
      try {
        return await actions.readProjectDoc(projectId, relative);
      } catch (err) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
    },
  );

  tool(
    "list_learned_allows",
    "Command shapes a human has already allowed at a permission gate, so they stop asking " +
      "(PE-10). Most used first; a shape used often is one somebody should turn into a matcher.",
    {},
    async () => actions.listLearnedAllows(),
  );

  tool(
    "forget_learned_allow",
    "Forget a learned allow, by its shape or id: the next command of that shape asks again (PE-10).",
    { shape: z.string().min(1) },
    async ({ shape }) => actions.forgetLearnedAllow("mcp", shape),
  );

  tool(
    "preview_start",
    "Start a development server the user can open in their own browser, and return its URL " +
      "(PV-01). Use this and never run `npm run dev`, `vite` or `python -m http.server` in a " +
      "terminal: those never return, so they hold the run open until the watchdog kills it — the " +
      "policy refuses them for that reason. LightsOut owns the process, binds it to a published " +
      "port, and keeps it alive after the run finishes so the result can be looked at.",
    {
      projectId: z.string().min(1),
      command: z
        .string()
        .min(1)
        .describe(
          "The server command, without host or port: those are set for you (PV-04). " +
            "e.g. `npm run dev`, or `node /opt/lightsout/dist/preview/serve.js --root dist --spa`.",
        ),
      port: z.number().int().optional().describe("A specific port from the pool; refused if taken."),
      cwd: z.string().optional().describe("Directory inside the project to run in."),
      ttlMinutes: z.number().int().positive().optional(),
    },
    async ({ projectId, command, port, cwd, ttlMinutes }) =>
      (await actions.startPreview("mcp", {
        projectId,
        command,
        ...(port !== undefined ? { port } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
      })) as unknown as Record<string, unknown>,
  );

  tool(
    "preview_stop",
    "Stop a preview server, by its id or every one of a project (PV-03).",
    { previewId: z.string().optional(), projectId: z.string().optional() },
    async ({ previewId, projectId }) =>
      actions.stopPreview("mcp", {
        ...(previewId ? { previewId } : {}),
        ...(projectId ? { projectId } : {}),
      }),
  );

  tool(
    "list_previews",
    "Development servers currently running, with their URL and whether the process is really " +
      "alive (PV-03). `alive: false` on a running row means it died; the URL will not load.",
    { projectId: z.string().optional() },
    async ({ projectId }) =>
      actions.listPreviews(projectId) as unknown as Record<string, unknown>,
  );

  tool(
    "preview_log",
    "The last lines of a preview's output. Where a server that started but serves nothing says " +
      "why — a missing dependency, a port conflict, a bad proxy target (§21.3).",
    { previewId: z.string().min(1), lines: z.number().int().positive().optional() },
    async ({ previewId, lines }) => ({
      lines: await actions.previewLog(previewId, lines),
    }),
  );

  tool(
    "list_toolchain_grants",
    "Which package managers each project may install into its own durable toolchain with " +
      "(ST-07). A toolchain outlives the run, unlike .lightsout/tmp/deps, and is authorised once " +
      "per project and per manager rather than at every install.",
    { projectId: z.string().optional() },
    async ({ projectId }) =>
      actions.listToolchainGrants(...(projectId ? [projectId] : [])) as unknown as Record<
        string,
        unknown
      >,
  );

  tool(
    "grant_toolchain",
    "Authorise a project to install into its own toolchain with this package manager (ST-07). " +
      "Normally granted by answering the permission doubt, where the actual command is visible; " +
      "this is for granting it ahead of time. apt and friends need root and are refused here — " +
      "they go through a toolchain doubt and a rebuild you run yourself (ST-08).",
    {
      projectId: z.string().min(1),
      manager: z.enum(TOOLCHAIN_MANAGERS as unknown as [string, ...string[]]),
      note: z.string().optional(),
    },
    async ({ projectId, manager, note }) =>
      actions.grantToolchain(
        "mcp",
        projectId,
        manager,
        ...(note !== undefined ? [note] : []),
      ) as unknown as Record<string, unknown>,
  );

  tool(
    "revoke_toolchain_grant",
    "Withdraw a toolchain authorisation: the next install with that manager asks again (ST-07). " +
      "What is already installed stays; this is about future installs, not a cleanup.",
    { projectId: z.string().min(1), manager: z.string().min(1) },
    async ({ projectId, manager }) => actions.revokeToolchainGrant("mcp", projectId, manager),
  );

  tool(
    "list_areas",
    "The workspace directories this project may read outside its own (PE-09), with both the " +
      "container path and the one on this machine.",
    { projectId: z.string().min(1) },
    async ({ projectId }) => actions.listAreas(projectId),
  );

  tool(
    "add_area",
    "Let this project read a directory of the workspace outside itself (PE-09) — the imported " +
      "source of a system, a folder of material. Read-only: an agent may copy from it into the " +
      "project, never write to it. Refused for the workspace root, agents/, templates/, " +
      "vault.yaml, knowledge/ and other projects.",
    { projectId: z.string().min(1), path: z.string().min(1), note: z.string().optional() },
    async ({ projectId, path: target, note }) =>
      actions.addArea("mcp", projectId, { path: target, ...(note ? { note } : {}) }),
  );

  tool(
    "remove_area",
    "Withdraw a read-only area from a project (PE-09), by its path or its id.",
    { projectId: z.string().min(1), path: z.string().min(1) },
    async ({ projectId, path: target }) => actions.removeArea("mcp", projectId, target),
  );

  tool(
    "resolve_path",
    "Where is this, really (MC-08)? Give a container path, a path on this machine, or a path " +
      "relative to a project, and get all of them back plus whether it exists. Use it before " +
      "telling a person where a file is.",
    { path: z.string().optional(), projectId: z.string().optional() },
    async ({ path: target, projectId }) =>
      actions.resolvePath({
        ...(target ? { path: target } : {}),
        ...(projectId ? { projectId } : {}),
      }),
  );

  tool(
    "set_project_context",
    "Rewrite the project's context brief (PM-09): what the project is for. It is injected into " +
      "every run's prompt, so this is how an agent's shared understanding is corrected.",
    { projectId: z.string().min(1), context: z.string().min(1) },
    async ({ projectId, context }) => actions.setProjectContext("mcp", projectId, context),
  );

  tool(
    "write_doc",
    "Overwrite one of the project's doc/ files. Refused while a run is active (MC-04).",
    { projectId: z.string().min(1), doc: z.enum(DOC_NAMES), content: z.string() },
    async ({ projectId, doc, content }) => {
      const row = project(projectId);
      if (activeRunFor(deps, row.id)) {
        throw conflict(`a run is active on ${row.id}; try again when it finishes`);
      }
      return actions.writeDoc("mcp", row.id, doc, content);
    },
  );

  tool(
    "consult",
    "Ask an engine a question in a throwaway read-only session (MC-05, DO-06).",
    {
      question: z.string().min(1),
      projectId: z.string().optional(),
      engine: z.enum(["claude", "codex"]).optional(),
    },
    async (args) => {
      const engine = args.engine ?? "codex";
      const cwd = args.projectId ? project(args.projectId).path : deps.config.workspace;
      const startedAt = Date.now();
      const answer = await askEngine({
        adapterCommand:
          engine === "claude" ? deps.config.adapterClaude : deps.config.adapterCodex,
        cwd,
        prompt: [
          "You are answering a question in a read-only session. Do not modify anything.",
          "Answer in plain language, no more than 200 words.",
          "",
          args.question,
        ].join("\n"),
      });
      return {
        answer: answer.trim(),
        engine,
        durationS: Math.round((Date.now() - startedAt) / 1000),
      };
    },
  );

  // --- Phase 9: templates, phases, knowledge and the vault (TP, KB, VT) ---

  /** Every phase 9 tool needs its subsystem loaded; say so once, clearly. */
  const need = <T>(value: T | undefined, what: string): T => {
    if (!value) throw new Error(`${what} is not available in this process`);
    return value;
  };

  tool(
    "list_templates",
    "Project templates, usable and rejected with their reason (TP-01, TP-03).",
    {},
    async () => {
      const loader = need(deps.templates, "templates");
      const snapshot = loader.current();
      return {
        templates: loader.list().map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          requiresWritableKnowledge: t.requires_writable_knowledge,
          phases: t.phases.map((p) => ({
            id: p.id,
            title: p.title,
            agent: p.agent,
            gate: p.gate,
            optional: p.optional,
            repeatable: p.repeatable,
            deliverable: p.deliverable ?? null,
          })),
        })),
        rejected: snapshot.rejected,
      };
    },
  );

  tool(
    "list_phases",
    "The phases of a project: what is done, running, pending, failed or skipped (TP-06).",
    { projectId: z.string().min(1) },
    async ({ projectId }) => ({
      phases: need(deps.phases, "phases")
        .list(project(projectId).id)
        .map((p) => ({
          id: p.id,
          ref: p.phase_id,
          position: p.position,
          title: p.title,
          agent: p.agent_id,
          gate: p.gate,
          status: p.status,
          optional: Boolean(p.optional),
          repeatable: Boolean(p.repeatable),
          deliverable: p.deliverable,
          taskId: p.task_id,
          startedAt: p.started_at,
          endedAt: p.ended_at,
        })),
    }),
  );

  tool(
    "launch_phase",
    "Run a phase: creates its task and queues it on the project's chain (TP-07). Both fields are " +
      "required (OR-10): `input` is what you are asking for this time — the raw request for a " +
      "shaping phase, the question for an answering one, the subsystem to analyse — and `expects` " +
      "is what must come back. The template's instructions were frozen months ago and do not know " +
      "which run this is.",
    {
      projectId: z.string().min(1),
      phase: z.string().min(1),
      input: z.string().min(1).describe("The request for this run of the phase."),
      expects: z
        .string()
        .min(1)
        .describe("What comes back, and how you decide it was met."),
      ...modelChoiceSchema,
    },
    async ({ projectId, phase, input, expects, engine, model, reasoning }) =>
      actions.launchPhase("mcp", project(projectId).id, phase, {
        request: input,
        expects,
        ...(engine ? { engine } : {}),
        ...(model ? { model } : {}),
        ...(reasoning ? { reasoning } : {}),
      }),
  );

  tool(
    "skip_phase",
    "Skip an optional phase and start the next pending one (TP-07).",
    { projectId: z.string().min(1), phase: z.string().min(1) },
    async ({ projectId, phase }) => {
      const skipped = await actions.skipPhase("mcp", project(projectId).id, phase);
      return { phaseId: skipped.id, ref: skipped.phase_id, status: skipped.status };
    },
  );

  tool(
    "add_phase",
    "Insert an ad-hoc phase at a position, shifting the rest down (TP-08).",
    {
      projectId: z.string().min(1),
      title: z.string().min(1),
      agentId: z.string().min(1),
      instructions: z.string().min(1),
      position: z.number().int().min(0).optional(),
      deliverable: z.string().optional(),
      verifyCmd: z.string().optional(),
      gate: z.enum(["auto", "human"]).optional(),
    },
    async (args) => {
      const added = actions.addPhase("mcp", project(args.projectId).id, {
        title: args.title,
        agentId: args.agentId,
        instructions: args.instructions,
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.deliverable !== undefined ? { deliverable: args.deliverable } : {}),
        ...(args.verifyCmd !== undefined ? { verifyCmd: args.verifyCmd } : {}),
        ...(args.gate !== undefined ? { gate: args.gate } : {}),
      });
      return { phaseId: added.id, ref: added.phase_id, position: added.position };
    },
  );

  tool(
    "list_knowledge",
    "Curated knowledge bases, and which ones a project has attached (KB-01, KB-03).",
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      const loader = need(deps.knowledge, "knowledge");
      const attached = projectId
        ? repos.projectKnowledge.list(project(projectId).id)
        : [];
      return {
        // Folders holding documents and no manifest, offered for adoption (KB-10).
        adoptable: loader.adoptable(),
        bases: loader.list().map((base) => ({
          id: base.manifest.id,
          name: base.manifest.name,
          kind: base.manifest.kind,
          /** `hard` means the agent may not decide against it (KB-11); `advisory` is context. */
          enforcement: base.manifest.enforcement,
          description: base.manifest.description,
          tags: base.manifest.tags,
          updated: base.manifest.updated ?? null,
          // The folder a linked base reads from, so an agent knows the documents are not the
          // base's own to edit (KB-08).
          source: base.source ?? null,
          documents: base.documents.map((d) => d.file),
          attached: attached.some((row) => row.base_id === base.manifest.id),
          writable: attached.some(
            (row) => row.base_id === base.manifest.id && row.writable === 1,
          ),
        })),
        rejected: loader.rejections(),
      };
    },
  );

  tool(
    "read_knowledge",
    "Read one document of a knowledge base, the call the injection block points at (KB-04).",
    { baseId: z.string().min(1), file: z.string().min(1) },
    async ({ baseId, file }) => ({
      baseId,
      file,
      content: await need(deps.knowledge, "knowledge").readDocument(baseId, file),
    }),
  );

  tool(
    "list_vault",
    "Vault entries: labels, URLs, notes and field names. Never a value (VT-03).",
    {},
    async () => ({ entries: await need(deps.vault, "vault").listViews() }),
  );

  // --- The write surface (MC-07) -------------------------------------------
  //
  // Everything the panel can configure, Claude Desktop can configure too. These are the same
  // three lines as the routes in `src/http/api-write.ts`, differing only in `actor` — the rules
  // are in `actions.ts` and nowhere else (§12.0). The vault is the deliberate exception: there is
  // no tool that writes a value, because a value sent through a tool call would travel through
  // the conversation to get here (VT-02).

  tool(
    "write_agent",
    "Create or edit an agent profile (AP-06). Editing a builtin writes the workspace copy that " +
      "shadows it, which is what `source: 'workspace'` then means. Only the fields you pass " +
      "change; the model must be one `list_agents` shows for that engine (AP-08).",
    {
      agentId: z.string().min(1),
      name: z.string().min(1).optional(),
      engine: z.enum(["claude", "codex"]).optional(),
      model: z.string().min(1).optional(),
      reasoning: z.enum(["minimal", "low", "medium", "high"]).optional(),
      instructions: z.string().optional(),
      policy: z.string().min(1).optional(),
      tags: z.array(z.string().min(1)).optional(),
      include: z.array(z.string().min(1)).optional(),
      deliverable: z.string().min(1).optional(),
      advisor: z.boolean().optional(),
      enabled: z.boolean().optional(),
    },
    async ({ agentId, ...patch }) => ({
      agent: await actions.writeAgent("mcp", agentId, stripUndefined(patch)),
    }),
  );

  tool(
    "set_agent_enabled",
    "Enable or disable a profile without deleting it. A disabled profile cannot be launched and " +
      "makes every template that names it unusable (AP-07).",
    { agentId: z.string().min(1), enabled: z.boolean() },
    async ({ agentId, enabled }) => ({
      agent: await actions.setAgentEnabled("mcp", agentId, enabled),
    }),
  );

  tool(
    "delete_agent",
    "Delete the workspace copy of a profile. A builtin of the same id reappears underneath, so " +
      "this is 'revert my changes', not 'destroy the agent' (AP-06).",
    { agentId: z.string().min(1) },
    async ({ agentId }) => actions.deleteAgent("mcp", agentId),
  );

  tool(
    "write_template",
    "Create a template, clone a builtin, or replace its phase list (TP-04). `phases` is the " +
      "whole list in order: to reorder, insert or remove, send the list you want. Every agent " +
      "named must exist and be enabled (TP-03).",
    {
      templateId: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      requiresWritableKnowledge: z.boolean().optional(),
      phases: z
        .array(
          z.object({
            id: z.string().min(1),
            title: z.string().min(1),
            agent: z.string().min(1),
            instructions: z.string().min(1),
            deliverable: z.string().min(1).optional(),
            verify: z.string().min(1).optional(),
            gate: z.enum(["auto", "human"]).optional(),
            optional: z.boolean().optional(),
            repeatable: z.boolean().optional(),
          }),
        )
        .min(1)
        .optional(),
    },
    async ({ templateId, requiresWritableKnowledge, ...rest }) => ({
      template: await actions.writeTemplate("mcp", templateId, {
        ...stripUndefined(rest),
        ...(requiresWritableKnowledge === undefined
          ? {}
          : { requires_writable_knowledge: requiresWritableKnowledge }),
      }),
    }),
  );

  tool(
    "delete_template",
    "Delete a workspace template. A project already created from it keeps its own frozen phases " +
      "and is unaffected (TP-04, TP-05).",
    { templateId: z.string().min(1) },
    async ({ templateId }) => actions.deleteTemplate("mcp", templateId),
  );

  tool(
    "write_knowledge",
    "Create a knowledge base or edit its manifest (KB-01). `source` points it at a folder " +
      "already in the workspace, which then stays the source of truth for its documents; pass " +
      "null to unlink and go back to the base's own folder (KB-08). `enforcement: hard` makes it " +
      "binding: agents may not decide against it, and a decision that would opens a doubt only " +
      "the user can settle (KB-11).",
    {
      baseId: z.string().min(1),
      name: z.string().min(1).optional(),
      kind: z
        .enum(["technical", "functional", "organisational", "market", "other"])
        .optional(),
      enforcement: z.enum(["advisory", "hard"]).optional(),
      description: z.string().optional(),
      tags: z.array(z.string().min(1)).optional(),
      owner: z.string().min(1).optional(),
      source: z.string().min(1).nullable().optional(),
    },
    async ({ baseId, source, ...rest }) => ({
      base: await actions.writeKnowledge("mcp", baseId, {
        ...stripUndefined(rest),
        ...(source === undefined ? {} : { source }),
      }),
    }),
  );

  tool(
    "adopt_knowledge",
    "Turn a folder of documents that is already in the workspace into a knowledge base (KB-10), " +
      "writing only what is missing: the manifest, and an index only if the folder has none. A " +
      "folder directly under knowledge/ becomes the base in place; anywhere else it gets a base " +
      "that links to it. `list_knowledge` reports the candidates under `adoptable`.",
    {
      folder: z.string().min(1),
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      kind: z
        .enum(["technical", "functional", "organisational", "market", "other"])
        .optional(),
      enforcement: z.enum(["advisory", "hard"]).optional(),
      description: z.string().optional(),
      tags: z.array(z.string().min(1)).optional(),
      owner: z.string().min(1).optional(),
    },
    async ({ folder, ...patch }) => actions.adoptKnowledge("mcp", folder, stripUndefined(patch)),
  );

  tool(
    "write_knowledge_doc",
    "Write one document into a base, or into the folder it is linked to. Text only: .md, " +
      ".markdown or .txt, because what a base is for is text that goes into a prompt (KB-08).",
    { baseId: z.string().min(1), file: z.string().min(1), content: z.string() },
    async ({ baseId, file, content }) =>
      actions.writeKnowledgeDoc("mcp", baseId, file, content),
  );

  tool(
    "delete_knowledge_doc",
    "Delete one document from a base. Refused on a linked base: that folder belongs to " +
      "something else, so the file goes from there (KB-08).",
    { baseId: z.string().min(1), file: z.string().min(1) },
    async ({ baseId, file }) => actions.deleteKnowledgeDoc("mcp", baseId, file),
  );

  tool(
    "delete_knowledge",
    "Delete a knowledge base. Refused while a project has it attached, because that project's " +
      "prompts would start quietly missing context (KB-03). A linked folder is left where it is.",
    { baseId: z.string().min(1) },
    async ({ baseId }) => actions.deleteKnowledge("mcp", baseId),
  );

  tool(
    "attach_knowledge",
    "Attach a knowledge base to a project, or detach it (KB-03). `writable` is only for a " +
      "knowledge-curation project, only one base at a time, and never a linked base (KB-05).",
    {
      projectId: z.string().min(1),
      baseId: z.string().min(1),
      detach: z.boolean().optional(),
      writable: z.boolean().optional(),
    },
    async ({ projectId, baseId, detach, writable }) => {
      const id = project(projectId).id;
      return detach
        ? actions.detachKnowledge("mcp", id, baseId)
        : actions.attachKnowledge("mcp", id, baseId, writable ?? false);
    },
  );

  // Keep the doubt service reachable for future tools without an unused-import warning.
  void doubts;
}

/** A field the caller omitted must not overwrite what is stored with `undefined`. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
