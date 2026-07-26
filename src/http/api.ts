/**
 * Read-only JSON API (WP-01, DESIGN §12.1).
 *
 * Every handler is SELECT-only against SQLite, or a read of the workspace for the config
 * resources (OB-01). The shapes come from `src/views.ts`, which the MCP tools use too, so the
 * panel and Claude Desktop can never disagree about what a run or a doubt looks like (§12.0).
 *
 * The resources phase 9 fills — templates, knowledge, the vault, per-project phases — answer
 * now with their empty shape rather than 404, so the panel can render them without branching on
 * "does this endpoint exist yet".
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { AgentsLoader } from "../agents/loader.js";
import type { HealthProbe } from "../health.js";
import { failure, notFound, success, type Envelope } from "../mcp/envelope.js";
import { doubtView, overviewView, projectStatusView } from "../views.js";
import type { TemplatesLoader } from "../templates/loader.js";
import type { KnowledgeLoader } from "../knowledge/loader.js";
import type { Vault } from "../vault/vault.js";
import { agentSource } from "../agents/writer.js";
import { ENGINE_MODELS } from "../agents/models.js";
import { listWorkspaceFolders } from "../knowledge/writer.js";
import { hostPathFor, listProjectDocs, readProjectDoc } from "../projects/docs-index.js";

export type ApiDeps = {
  config: Config;
  repos: Repos;
  agents: AgentsLoader;
  health: HealthProbe;
  /** Phase 9 material. Absent in a process that does not load it; the routes say so. */
  templates?: TemplatesLoader;
  knowledge?: KnowledgeLoader;
  vault?: Vault;
};

async function envelope(
  reply: FastifyReply,
  handler: () => Promise<Record<string, unknown>>,
): Promise<Envelope> {
  try {
    return success(await handler());
  } catch (err) {
    const body = failure(err);
    const code = !body.ok ? body.error.code : "INTERNAL";
    reply.code(code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409);
    return body;
  }
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { config, repos, agents, health } = deps;
  const views = { config, repos };

  const project = (id: string) => {
    const row = repos.projects.get(id);
    if (!row) throw notFound(`project not found: ${id}`);
    return row;
  };

  app.get("/api/overview", async (request, reply) =>
    envelope(reply, async () => {
      // `?archived=true` is how the panel reaches an archived project to unarchive it (PM-08).
      const query = z
        .object({ archived: z.enum(["true", "false"]).optional() })
        .parse(request.query ?? {});
      return overviewView(views, await health.engines(), {
        includeArchived: query.archived === "true",
      });
    }),
  );

  app.get("/api/projects", async (request, reply) =>
    envelope(reply, async () => {
      const query = z
        .object({ archived: z.enum(["true", "false"]).optional() })
        .parse(request.query ?? {});
      const overview = overviewView(views, await health.engines());
      return {
        projects:
          query.archived === "true"
            ? repos.projects
                .list({ includeArchived: true })
                .map((p) => ({ id: p.id, name: p.name, path: p.path, archived: p.archived === 1 }))
            : overview.projects,
      };
    }),
  );

  app.get("/api/projects/:id", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      return projectStatusView(views, project(id));
    }),
  );

  app.get("/api/projects/:id/history", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          before: z.string().optional(),
        })
        .parse(request.query ?? {});
      const row = project(id);
      const runs = repos.runs.history({
        projectId: row.id,
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.before ? { before: query.before } : {}),
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
            ? Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)
            : null,
          costUsd: r.cost_usd,
          summary: r.summary,
          exitReason: r.exit_reason,
        })),
        totals: { byStatus, costUsd: costUsd || null, runs: runs.length },
      };
    }),
  );

  /** The run timeline the project view tails; `after` is the same cursor the SSE stream uses. */
  app.get("/api/runs/:id/events", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const query = z
        .object({
          after: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        })
        .parse(request.query ?? {});
      const run = repos.runs.get(id);
      if (!run) throw notFound(`run not found: ${id}`);
      const rows = repos.events.listByRun(id, {
        ...(query.after !== undefined ? { after: query.after } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
      return {
        runId: id,
        events: rows.map((row) => ({
          id: row.id,
          ts: row.ts,
          type: row.type,
          payload: JSON.parse(row.payload) as unknown,
        })),
        cursor: rows.at(-1)?.id ?? query.after ?? 0,
      };
    }),
  );

  app.get("/api/doubts", async (request, reply) =>
    envelope(reply, async () => {
      const query = z
        .object({
          projectId: z.string().optional(),
          status: z.enum(["open", "answered", "closed"]).optional(),
        })
        .parse(request.query ?? {});
      return {
        doubts: repos.doubts
          .list({
            ...(query.projectId ? { projectId: query.projectId } : {}),
            status: query.status ?? "open",
          })
          .map((d) => doubtView(views, d)),
      };
    }),
  );

  app.get("/api/agents", async (_request, reply) =>
    envelope(reply, async () => {
      const snapshot = agents.current();
      // Where each definition comes from, so the editor can say "this is a builtin, saving
      // will make a workspace copy" instead of pretending they are the same thing (§2, AP-06).
      const sources = new Map<string, "builtin" | "workspace">();
      for (const id of snapshot.profiles.keys()) {
        sources.set(id, (await agentSource(agents, id)) ?? "builtin");
      }
      return {
        agents: [
          ...[...snapshot.profiles.values()].map((p) => ({
            id: p.id,
            name: p.name,
            engine: p.engine,
            model: p.model ?? null,
            reasoning: p.reasoning ?? null,
            instructions: p.instructions,
            policy: p.policy,
            tags: p.tags,
            deliverable: p.deliverable ?? null,
            advisor: p.advisor,
            source: sources.get(p.id) ?? "builtin",
            enabled: p.enabled,
            valid: true,
            error: null as string | null,
          })),
          ...snapshot.rejected.map((r) => ({
            id: r.file.replace(/\.(ya?ml)$/i, ""),
            name: r.file,
            engine: null,
            model: null,
            policy: null,
            advisor: null,
            source: "workspace" as const,
            enabled: false,
            valid: false,
            error: r.error,
          })),
        ],
        packs: [...snapshot.packs.keys()],
      };
    }),
  );

  app.get("/api/agents/models", async (_request, reply) =>
    envelope(reply, async () => ({ engines: ENGINE_MODELS })),
  );

  // Phase 9 resources (TP, KB, VT). A process without them answers the same empty shape
  // rather than 404, so the panel's renderers are written once.
  app.get("/api/projects/:id/phases", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const row = project(id);
      return {
        available: true,
        phases: repos.phases.list(row.id).map((phase) => ({
          id: phase.id,
          ref: phase.phase_id,
          position: phase.position,
          title: phase.title,
          agent: phase.agent_id,
          gate: phase.gate,
          status: phase.status,
          optional: Boolean(phase.optional),
          repeatable: Boolean(phase.repeatable),
          deliverable: phase.deliverable,
          taskId: phase.task_id,
          startedAt: phase.started_at,
          endedAt: phase.ended_at,
        })),
        knowledge: repos.projectKnowledge.list(row.id).map((k) => ({
          baseId: k.base_id,
          kind: k.kind,
          writable: k.writable === 1,
        })),
      };
    }),
  );

  // --- The project's documents (PM-10, DESIGN §9.4) --------------------------

  app.get("/api/projects/:id/docs", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const row = project(id);
      const docs = await listProjectDocs(row.path);
      return {
        projectId: row.id,
        root: row.path,
        hostRoot: hostPathFor(config.workspace, config.workspaceHost, row.path),
        docs: docs.map((entry) => ({
          ...entry,
          hostPath: hostPathFor(
            config.workspace,
            config.workspaceHost,
            `${row.path}/${entry.path}`,
          ),
        })),
      };
    }),
  );

  app.get("/api/projects/:id/doc", async (request, reply) =>
    envelope(reply, async () => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      const { path: relative } = z.object({ path: z.string().min(1) }).parse(request.query);
      const row = project(id);
      try {
        const doc = await readProjectDoc(row.path, relative);
        return {
          projectId: row.id,
          ...doc,
          hostPath: hostPathFor(
            config.workspace,
            config.workspaceHost,
            `${row.path}/${doc.path}`,
          ),
        };
      } catch (err) {
        throw notFound(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  app.get("/api/templates", async (_request, reply) =>
    envelope(reply, async () => {
      if (!deps.templates) return { templates: [], rejected: [], available: false };
      return {
        available: true,
        templates: deps.templates.list().map((t) => ({
          id: t.id,
          name: t.name,
          source: deps.templates!.current().sources.get(t.id) ?? "builtin",
          description: t.description,
          requiresWritableKnowledge: t.requires_writable_knowledge,
          phases: t.phases.map((p) => ({
            id: p.id,
            title: p.title,
            agent: p.agent,
            instructions: p.instructions,
            gate: p.gate,
            optional: p.optional,
            repeatable: p.repeatable,
            deliverable: p.deliverable ?? null,
            verify: p.verify ?? null,
          })),
        })),
        rejected: deps.templates.current().rejected,
      };
    }),
  );

  app.get("/api/knowledge", async (_request, reply) =>
    envelope(reply, async () => {
      if (!deps.knowledge) return { bases: [], rejected: [], available: false };
      return {
        available: true,
        bases: deps.knowledge.list().map((base) => ({
          id: base.manifest.id,
          name: base.manifest.name,
          kind: base.manifest.kind,
          /** Whether the base binds the agent or merely informs it (KB-11). */
          enforcement: base.manifest.enforcement,
          description: base.manifest.description,
          tags: base.manifest.tags,
          owner: base.manifest.owner ?? null,
          updated: base.manifest.updated ?? null,
          // The folder a linked base reads from, so the panel can say the documents are not
          // its to edit (KB-08).
          source: base.source ?? null,
          documents: base.documents.map((d) => ({ file: d.file, bytes: d.bytes })),
        })),
        rejected: deps.knowledge.rejections(),
        // Folders under knowledge/ holding documents and no manifest: an invitation, not an
        // error (KB-10).
        adoptable: deps.knowledge.adoptable(),
      };
    }),
  );

  /** The workspace tree a base could be linked to or adopted from (KB-08, KB-10). */
  app.get("/api/knowledge/folders", async (_request, reply) =>
    envelope(reply, async () => {
      const basesByPath = new Map<string, string>();
      for (const base of deps.knowledge?.list() ?? []) {
        basesByPath.set(`knowledge/${base.manifest.id}`, base.manifest.id);
        if (base.source) basesByPath.set(base.source, base.manifest.id);
      }
      return { folders: await listWorkspaceFolders(config.workspace, { basesByPath }) };
    }),
  );

  app.get("/api/knowledge/:baseId/doc", async (request, reply) =>
    envelope(reply, async () => {
      const { baseId } = z.object({ baseId: z.string().min(1) }).parse(request.params);
      const { path: file } = z.object({ path: z.string().min(1) }).parse(request.query);
      const loader = deps.knowledge;
      if (!loader) throw notFound("knowledge is not available in this process");
      return { baseId, file, content: await loader.readDocument(baseId, file) };
    }),
  );

  // Field names and whether a value is set; there is no route that returns one (VT-03).
  app.get("/api/vault", async (_request, reply) =>
    envelope(reply, async () => {
      if (!deps.vault) return { entries: [], available: false };
      return { available: true, entries: await deps.vault.listViews() };
    }),
  );
}
