/**
 * Setup and export routes (SU-03..06, DESIGN §12.1b, §14.3..§14.5).
 *
 * Everything the first-run wizard needs and nothing else. Each handler is thin: it validates
 * with zod, calls one function that already exists elsewhere, and shapes the answer into the
 * same `{ok,…}` / `{ok:false,error:{code,message}}` envelope the MCP tools use, so the panel and
 * Claude Desktop get identical refusals (SU-05).
 *
 * The workspace route cannot remount anything: a container cannot change its own bind mounts.
 * It confirms the path it was given, or answers with the one line to edit and a restart.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";
import type { Repos } from "../db/repos/index.js";
import type { HealthProbe } from "../health.js";
import { failure, invalid, notFound, success, type Envelope } from "../mcp/envelope.js";
import { createProject } from "../projects/scaffold.js";
import { LoginFlows } from "../setup/login-flows.js";
import { buildZip, type ZipEntry } from "./zip.js";

const execFileAsync = promisify(execFile);

/** Marks the wizard step the user has confirmed; the panel reads it to reopen where it left. */
export const SETUP_KEYS = {
  workspaceConfirmed: "setup.workspace_confirmed_at",
  mcpLastSeen: "mcp.last_seen_at",
  completedAt: "setup.completed_at",
} as const;

export type SetupDeps = {
  config: Config;
  repos: Repos;
  health: HealthProbe;
  loginFlows: LoginFlows;
};

const engineSchema = z.enum(["claude", "codex"]);

/** Answer with the shared envelope; a thrown ToolError keeps its code, anything else is INTERNAL. */
async function envelope(
  reply: FastifyReply,
  handler: () => Promise<Record<string, unknown>>,
): Promise<Envelope> {
  try {
    return success(await handler());
  } catch (err) {
    // A schema failure is the caller's fault, not an internal one: say so with 400.
    const body = failure(
      err instanceof z.ZodError
        ? invalid(err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "))
        : err,
    );
    const code = !body.ok ? body.error.code : "INTERNAL";
    reply.code(code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409);
    return body;
  }
}

/** Every file under `dir`, relative paths, depth-first, skipping nothing (the .git clone matters). */
async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Build the export archive (SU-06, §14.5): a local clone, so the git history travels with the
 * files, zipped in memory. `git clone --local` hardlinks objects instead of copying them, which
 * keeps this cheap even on a project with a long history.
 */
async function exportProjectZip(projectPath: string, slug: string): Promise<Buffer> {
  const scratch = await mkdtemp(path.join(tmpdir(), "lo-export-"));
  const target = path.join(scratch, slug);
  try {
    try {
      await execFileAsync("git", ["clone", "--local", "--no-hardlinks", projectPath, target], {
        timeout: 120_000,
      });
    } catch {
      // Not a git repository yet (or git refused the clone): fall back to the files as they are.
      await execFileAsync("cp", ["-a", projectPath, target], { timeout: 120_000 });
    }
    const files = await walk(target);
    const entries: ZipEntry[] = [];
    for (const rel of files) {
      const full = path.join(target, rel);
      const info = await stat(full);
      entries.push({ name: `${slug}/${rel}`, data: await readFile(full), mtime: info.mtime });
    }
    return buildZip(entries);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): void {
  const { config, repos, health, loginFlows } = deps;

  /**
   * What the wizard needs to decide which step to open on (§14.3): the mounted workspace, the
   * engine auth state, whether Claude Desktop has ever called /mcp, and whether any project
   * exists. All of it read-only.
   */
  app.get("/api/setup/state", async (_request, reply) =>
    envelope(reply, async () => {
      const engines = await health.engines();
      const projects = repos.projects.list({ includeArchived: false });
      const mcpLastSeen = repos.settings.get(SETUP_KEYS.mcpLastSeen) ?? null;
      return {
        workspace: {
          path: config.workspace,
          mode: config.workspaceMode,
          confirmedAt: repos.settings.get(SETUP_KEYS.workspaceConfirmed) ?? null,
        },
        engines: engines.map((e) => ({
          engine: e.engine,
          detected: e.detected,
          auth: e.auth,
          authSource: e.authSource,
        })),
        mcp: {
          // The published mapping keeps the container port, so this is also the host URL (§14.3).
          url: `http://127.0.0.1:${config.port}/mcp`,
          lastSeenAt: mcpLastSeen,
          connected: mcpLastSeen !== null,
        },
        projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
        // Phase 9 ships the builtin library; until then the scaffold is the only template (TP-02).
        templates: [
          { id: "scaffold", name: "Empty project (doc/ scaffold)", source: "builtin", phases: 0 },
        ],
        completedAt: repos.settings.get(SETUP_KEYS.completedAt) ?? null,
      };
    }),
  );

  /**
   * Confirm the mounted workspace, or ask for another one (RT-02). A container cannot remount
   * itself, so a different path is answered with the exact line to change and a restart.
   */
  app.post("/api/setup/workspace", async (request, reply) =>
    envelope(reply, async () => {
      const body = z.object({ path: z.string().min(1).optional() }).parse(request.body ?? {});
      const wanted = body.path?.trim();
      if (wanted && path.resolve(wanted) !== path.resolve(config.workspace)) {
        return {
          confirmed: false,
          requiresRestart: true,
          current: config.workspace,
          requested: wanted,
          instruction:
            "Edit the workspace line at the top of Start-LightsOut.ps1 and start LightsOut again.",
          line: `$Workspace = "${wanted}"`,
        };
      }
      const at = new Date().toISOString();
      repos.settings.set(SETUP_KEYS.workspaceConfirmed, at);
      repos.events.append({
        type: "system",
        payload: { reason: "workspace confirmed", path: config.workspace, mode: config.workspaceMode },
      });
      return { confirmed: true, path: config.workspace, mode: config.workspaceMode, at };
    }),
  );

  /** Start an interactive engine login inside the container; the panel then subscribes (SU-04). */
  app.post("/api/setup/login/:engine", async (request, reply) =>
    envelope(reply, async () => {
      const { engine } = z.object({ engine: engineSchema }).parse(request.params);
      const probe = (await health.engines()).find((e) => e.engine === engine);
      if (!probe?.detected) throw invalid(`the ${engine} CLI is not available in this image`);
      const flowId = await loginFlows.start(engine);
      repos.events.append({ type: "system", payload: { reason: "login started", engine, flowId } });
      return { flowId, engine };
    }),
  );

  /**
   * Live login progress as SSE: url, code, log lines, then the final auth state (§14.4).
   * Buffered events are replayed on subscribe, so a browser that connects late sees the URL.
   */
  app.get("/api/setup/login/:flowId", async (request, reply) => {
    const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
    if (!loginFlows.get(flowId)) {
      return reply.code(404).send(failure(notFound(`login flow not found: ${flowId}`)));
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const send = (event: unknown) => raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = loginFlows.subscribe(flowId, (event) => {
      send(event);
      if (event.type === "done") raw.end();
    });
    const keepalive = setInterval(() => raw.write(": keepalive\n\n"), 15_000);
    raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    return reply;
  });

  /** Cancel a login the user walked away from, so the CLI does not sit waiting. */
  app.delete("/api/setup/login/:flowId", async (request, reply) =>
    envelope(reply, async () => {
      const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
      if (!loginFlows.get(flowId)) throw notFound(`login flow not found: ${flowId}`);
      return { cancelled: loginFlows.cancel(flowId) };
    }),
  );

  /** Store an API key through the engine CLI (NF-03). The value is never logged or persisted here. */
  app.post("/api/setup/login/:engine/key", async (request, reply) =>
    envelope(reply, async () => {
      const { engine } = z.object({ engine: engineSchema }).parse(request.params);
      const { key } = z.object({ key: z.string().min(8) }).parse(request.body ?? {});
      const result = await loginFlows.storeApiKey(engine, key);
      repos.events.append({
        type: "system",
        payload: { reason: "api key submitted", engine, accepted: result.auth },
      });
      return {
        engine,
        accepted: result.auth,
        authSource: result.authSource,
        exitCode: result.exitCode,
        output: result.auth ? null : result.output,
      };
    }),
  );

  /**
   * Create a project (§12.1b). Wizard step 4 needs it in phase 8; phase 10 moves it into
   * `src/http/api-write.ts` with the rest of the write surface, behind the same action.
   */
  app.post("/api/projects", async (request, reply) =>
    envelope(reply, async () => {
      const body = z
        .object({
          name: z.string().min(1),
          remote: z.string().optional(),
          verify: z.string().optional(),
          push: z.enum(["auto", "manual", "never"]).optional(),
          defaultAgent: z.string().optional(),
        })
        .parse(request.body ?? {});
      const result = await createProject(repos, config.workspace, {
        name: body.name,
        ...(body.remote ? { remote: body.remote } : {}),
        ...(body.verify !== undefined ? { verify: body.verify } : {}),
        ...(body.push ? { push: body.push } : {}),
        ...(body.defaultAgent ? { defaultAgent: body.defaultAgent } : {}),
      });
      return {
        project: { id: result.project.id, name: result.project.name, path: result.project.path },
        created: result.created,
      };
    }),
  );

  /** Mark the wizard done so the panel stops opening on it (§14.3: repeatable from #/setup). */
  app.post("/api/setup/complete", async (_request, reply) =>
    envelope(reply, async () => {
      const at = new Date().toISOString();
      repos.settings.set(SETUP_KEYS.completedAt, at);
      return { completedAt: at };
    }),
  );

  /** Project export as a zip download (SU-06, §14.5). */
  app.post("/api/export/project/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const project = repos.projects.get(id);
    if (!project) return reply.code(404).send(failure(notFound(`project not found: ${id}`)));
    try {
      const zip = await exportProjectZip(project.path, project.id);
      repos.events.append({
        type: "system",
        payload: { reason: "project exported", projectId: project.id, bytes: zip.length },
      });
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="${project.id}.zip"`)
        .header("content-length", String(zip.length))
        .send(zip);
    } catch (err) {
      return reply.code(500).send(failure(err));
    }
  });
}
