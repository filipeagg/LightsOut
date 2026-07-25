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
import type { ProjectRow } from "../db/types.js";
import { createProject } from "../projects/scaffold.js";
import { askEngine } from "../acp/advisor.js";
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
  version: string;
};

const DOC_NAMES = ["STATE", "PLAN", "DECISIONS", "QUESTIONS"] as const;
const levelSchema = z.enum(["quick", "full"]);

function docPath(project: ProjectRow, doc: string): string {
  return path.join(project.path, "doc", `${doc}.md`);
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const { repos, orchestrator, agents, doubts } = deps;

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
      version: deps.version,
    };
  });

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
    "Scaffold a project: doc/ templates, lightsout.yaml, git init and the initial commit (PM-01).",
    {
      name: z.string().min(1),
      remote: z.string().optional(),
      verify: z.string().optional(),
      push: z.enum(["auto", "manual", "never"]).optional(),
      defaultAgent: z.string().optional(),
    },
    async (args) => {
      const result = await createProject(repos, deps.config.workspace, {
        name: args.name,
        ...(args.remote !== undefined ? { remote: args.remote } : {}),
        ...(args.verify !== undefined ? { verify: args.verify } : {}),
        ...(args.push !== undefined ? { push: args.push } : {}),
        ...(args.defaultAgent !== undefined ? { defaultAgent: args.defaultAgent } : {}),
      });
      return {
        project: { id: result.project.id, path: result.project.path },
        created: result.created,
      };
    },
  );

  tool(
    "project_status",
    "Everything about one project in a single call: chain, current run, doubts and state (MC-06).",
    { projectId: z.string().min(1) },
    async ({ projectId }) => projectStatusView(deps, project(projectId)),
  );

  tool("list_agents", "Agent profiles, valid and rejected (AP-02).", {}, async () => {
    const snapshot = agents.current();
    return {
      agents: [
        ...[...snapshot.profiles.values()].map((p) => ({
          id: p.id,
          name: p.name,
          engine: p.engine,
          model: p.model ?? null,
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
  });

  tool("reload_agents", "Re-read profiles and policy packs from the workspace (AP-03).", {}, async () => {
    const report = await agents.load();
    return { loaded: report.loaded, packs: report.packs, rejected: report.rejected };
  });

  tool(
    "launch_chain",
    "Queue a chain of tasks and start it if the project is free. Returns immediately (MC-06).",
    {
      projectId: z.string().min(1),
      title: z.string().min(1),
      tasks: z
        .array(
          z.object({
            title: z.string().min(1),
            spec: z.string().min(1),
            agentId: z.string().min(1),
            level: levelSchema.optional(),
            verify: z.string().optional(),
          }),
        )
        .min(1),
    },
    async (args) => {
      project(args.projectId);
      for (const task of args.tasks) agents.profileOrThrow(task.agentId);
      const launch = orchestrator.launchChain({
        projectId: args.projectId,
        title: args.title,
        tasks: args.tasks.map((t) => ({
          title: t.title,
          spec: t.spec,
          agentId: t.agentId,
          ...(t.level ? { level: t.level } : {}),
          ...(t.verify !== undefined ? { verifyCmd: t.verify } : {}),
        })),
      });
      return launch as unknown as Record<string, unknown>;
    },
  );

  tool(
    "launch_task",
    "Queue one task, appending to a chain when given. Returns immediately (MC-06).",
    {
      projectId: z.string().min(1),
      title: z.string().min(1),
      spec: z.string().min(1),
      agentId: z.string().min(1),
      level: levelSchema.optional(),
      verify: z.string().optional(),
      chainId: z.string().optional(),
    },
    async (args) => {
      project(args.projectId);
      agents.profileOrThrow(args.agentId);
      const launch = orchestrator.launchTask({
        projectId: args.projectId,
        title: args.title,
        spec: args.spec,
        agentId: args.agentId,
        ...(args.level ? { level: args.level } : {}),
        ...(args.verify !== undefined ? { verifyCmd: args.verify } : {}),
        ...(args.chainId ? { chainId: args.chainId } : {}),
      });
      return {
        taskId: launch.taskIds[0],
        chainId: launch.chainId,
        queued: launch.queued,
        started: launch.started,
      };
    },
  );

  tool(
    "abort_run",
    "Abort a chain, dropping its queued tasks (OR-06).",
    { runId: z.string().optional(), chainId: z.string().optional() },
    async ({ runId, chainId }) => {
      if (!runId && !chainId) throw invalid("give runId or chainId");
      const chain = chainId
        ? repos.chains.getOrThrow(chainId)
        : (() => {
            const run = repos.runs.get(runId as string);
            if (!run) throw notFound(`run not found: ${runId}`);
            const task = repos.tasks.getOrThrow(run.task_id);
            return repos.chains.getOrThrow(task.chain_id);
          })();
      return { aborted: orchestrator.abortChain(chain.id), chainId: chain.id };
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
    async (args) => {
      const result = await orchestrator.answerDoubt({
        doubtId: args.doubtId,
        choice: args.choice,
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      });
      return { ref: result.ref, resumed: result.resumed };
    },
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
      const row = project(projectId);
      try {
        const file = docPath(row, doc);
        const content = await readFile(file, "utf8");
        return { content, doc, path: file };
      } catch {
        throw notFound(`${doc}.md does not exist in ${row.id}`);
      }
    },
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
      await writeFile(docPath(row, doc), content, "utf8");
      repos.events.append({
        type: "system",
        payload: { reason: "doc written", projectId: row.id, doc },
      });
      return { written: true, doc };
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

  // Keep the doubt service reachable for future tools without an unused-import warning.
  void doubts;
}
