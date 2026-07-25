/**
 * HTTP server: panel (static), read-only JSON API, SSE and /health (DESIGN §12).
 * Phase 1 delivers /health plus the static panel mount; the read-only JSON API
 * and SSE arrive in phase 7 (WP-01..08).
 *
 * Static files are served by a small handler instead of a plugin: the panel is a
 * fixed set of files with no build step (ST-04), so no extra dependency is needed.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { HealthProbe } from "../health.js";
import type { Repos } from "../db/repos/index.js";
import { mountMcp } from "../mcp/server.js";
import type { McpDeps } from "../mcp/tools.js";
import type { LoginFlows } from "../setup/login-flows.js";
import type { AgentsLoader } from "../agents/loader.js";
import { registerSetupRoutes, SETUP_KEYS } from "./setup.js";
import { registerApiRoutes } from "./api.js";
import { registerStreamRoute } from "./stream.js";

export type ServerDeps = {
  config: Config;
  bus: Bus;
  health: HealthProbe;
  /** Read-only access for the JSON API and SSE (phase 7); SELECT-only (OB-01). */
  repos: Repos;
  checkDatabase: () => { ok: boolean; error?: string };
  /** When present, the MCP endpoint is mounted at /mcp (MC-01). */
  mcp?: McpDeps;
  /** Interactive engine logins driven from the wizard (SU-04). */
  loginFlows: LoginFlows;
  /** Agent profiles for the read API (WP-01, AP-02). */
  agents: AgentsLoader;
};

const PANEL_DIR = path.resolve(process.cwd(), "panel");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Resolve a request path inside the panel directory, or null if it escapes it. */
function resolvePanelFile(urlPath: string): string | null {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const target = path.resolve(PANEL_DIR, rel);
  const withinPanel =
    target === PANEL_DIR || target.startsWith(PANEL_DIR + path.sep);
  return withinPanel ? target : null;
}

export async function createHttpServer(deps: ServerDeps): Promise<FastifyInstance> {
  // Log level defaults to "warn": the panel polls constantly, and per-request
  // info lines would drown the boot and run output. Errors still surface.
  const app = Fastify({
    logger: { level: process.env.LO_LOG_LEVEL ?? "warn" },
  });

  app.get("/health", async () => {
    const db = deps.checkDatabase();
    return deps.health.snapshot(db.ok, db.error);
  });

  // Read-only JSON API and the event stream (WP-01, WP-03, §12.1/§12.2).
  registerApiRoutes(app, {
    config: deps.config,
    repos: deps.repos,
    agents: deps.agents,
    health: deps.health,
  });
  registerStreamRoute(app, {
    config: deps.config,
    bus: deps.bus,
    repos: deps.repos,
    health: deps.health,
  });

  // Setup, wizard and export routes (SU-03..06, §12.1b).
  registerSetupRoutes(app, {
    config: deps.config,
    repos: deps.repos,
    health: deps.health,
    loginFlows: deps.loginFlows,
  });

  // MCP endpoint (MC-01). Mounted before the static catch-all so /mcp is not served as a file.
  // The timestamp is what turns wizard step 3's "test connection" indicator green (§14.3).
  if (deps.mcp) {
    await mountMcp(app, deps.mcp, () => {
      try {
        deps.repos.settings.set(SETUP_KEYS.mcpLastSeen, new Date().toISOString());
      } catch {
        // A settings write must never break an MCP request.
      }
    });
  }

  app.get("/*", async (request, reply) => {
    const file = resolvePanelFile(request.url.split("?")[0] ?? "/");
    if (!file) return reply.code(400).send({ error: "bad path" });
    try {
      const body = await readFile(file);
      return reply
        .type(MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream")
        .send(body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  app.get("/", async (request, reply) => {
    try {
      return reply
        .type("text/html; charset=utf-8")
        .send(await readFile(path.join(PANEL_DIR, "index.html")));
    } catch {
      return reply.code(404).send({ error: "panel not installed" });
    }
  });

  return app;
}
