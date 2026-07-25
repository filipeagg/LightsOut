/**
 * Boot sequence (DESIGN §11.1).
 * Phase 1 covers: config → bus → engine detection → HTTP (health + panel) →
 * graceful shutdown (RT-07). DB, recovery, orchestrator, ACP and MCP are added
 * by later phases at the marked points.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createBus } from "./bus.js";
import { HealthProbe } from "./health.js";
import { createHttpServer } from "./http/server.js";
import { checkDatabase, openDb } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { createRepos } from "./db/repos/index.js";
import { AgentsLoader } from "./agents/loader.js";
import { ensureWorkspaceLayout } from "./workspace/layout.js";
import { recoverInterrupted } from "./orchestrator/recovery.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { DoubtService } from "./orchestrator/doubts.js";
import { LoginFlows } from "./setup/login-flows.js";

async function readVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(path.resolve(here, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  // 1. Config (aborts on invalid).
  const config = loadConfig();
  const version = await readVersion();
  const bus = createBus();

  // 2. Database: single writable connection, migrations applied before anything reads.
  const db = openDb({ file: config.dbPath });
  const migration = migrate(db);
  if (migration.applied.length > 0) {
    console.log(
      `[boot] migrations ${migration.from} -> ${migration.to}: ${migration.applied.join(", ")}`,
    );
  }
  const repos = createRepos(db);

  // 3. Recovery pass (§11.2): interrupted work is surfaced, never silently retried.
  const recovery = recoverInterrupted(repos);
  if (recovery.runs > 0) {
    console.warn(
      `[boot] ${recovery.runs} run(s) marked interrupted, ${recovery.chainsPaused.length} chain(s) paused (RT-07)`,
    );
  }

  // 4. Workspace layout (RT-02, §11.1 step 4): the loaders and the scaffolder assume it exists.
  const layout = await ensureWorkspaceLayout(config.workspace);
  console.log(
    `[boot] workspace ${config.workspace} (${config.workspaceMode})` +
      (layout.created.length > 0 ? `: created ${layout.created.join(", ")}` : "") +
      (layout.gitignoreUpdated ? " (.gitignore updated)" : ""),
  );

  // 4b. Agent profiles and policy packs (AP-01..03), seeded from examples on first boot.
  const agents = new AgentsLoader(config.workspace, (report) => {
    console.log(`[agents] reloaded: ${report.loaded} profile(s), ${report.packs} pack(s)`);
    for (const bad of report.rejected) console.warn(`[agents] rejected ${bad.file}: ${bad.error}`);
    repos.events.append({
      type: "system",
      payload: { reason: "agents reloaded", loaded: report.loaded, rejected: report.rejected },
    });
    bus.emit("overview");
  });
  const agentsReport = await agents.load();
  console.log(
    `[boot] agents: ${agentsReport.loaded} profile(s), ${agentsReport.packs} pack(s)` +
      (agentsReport.seeded ? " (examples seeded)" : ""),
  );
  for (const bad of agentsReport.rejected) {
    console.warn(`[boot] rejected agent file ${bad.file}: ${bad.error}`);
  }
  agents.startWatching(config.watchPollMs);

  // 5. Engine detection and auth probe (RT-04, RT-06).
  const health = new HealthProbe(config, version);
  const engines = await health.engines(true);
  for (const e of engines) {
    const state = !e.detected
      ? "adapter not found on PATH"
      : e.auth
        ? `authenticated (${e.authSource})`
        : "NOT authenticated — run scripts/login-" + e.engine + ".sh";
    console.log(`[boot] engine ${e.engine} (${e.adapter}): ${state}`);
  }
  if (config.egress !== "proxy") {
    console.warn("[boot] network: unrestricted (egress allowlist disabled, RT-05)");
  }

  // 5b. Orchestrator: owns chains, project locks and the concurrency cap (OR-*, SR-07).
  // Phase 6 exposes it over MCP; nothing resumes on its own after a restart (RT-07).
  const orchestrator = new Orchestrator(config, repos, bus, agents);

  // 5c. Interactive engine logins driven from the browser (SU-04).
  const loginFlows = new LoginFlows(health);

  // 6. HTTP: panel, health, setup wizard and /mcp (the read-only JSON API lands in phase 7).
  const app = await createHttpServer({
    config,
    bus,
    health,
    repos,
    loginFlows,
    checkDatabase: () => checkDatabase(db),
    mcp: {
      config,
      repos,
      agents,
      health,
      orchestrator,
      doubts: new DoubtService(config, repos, bus, agents),
      version,
    },
  });
  await app.listen({ host: config.bind, port: config.port });
  console.log(`[boot] listening on http://${config.bind}:${config.port}`);

  // 7. Graceful shutdown (RT-07): cancel work, persist state, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);
    agents.stopWatching();
    loginFlows.closeAll();
    const active = orchestrator.activeRuns;
    if (active.length > 0) {
      console.log(`[shutdown] waiting for ${active.length} active run(s)`);
      await orchestrator.idle();
    }
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
