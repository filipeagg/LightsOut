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
import { PhaseService } from "./orchestrator/phases.js";
import { TemplatesLoader } from "./templates/loader.js";
import { KnowledgeLoader } from "./knowledge/loader.js";
import { Vault } from "./vault/vault.js";
import { Actions } from "./control/actions.js";
import { LoginFlows } from "./setup/login-flows.js";
import { PreviewManager } from "./preview/manager.js";

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
  // Reported separately: a phase can need reconciling with no run to interrupt, when an earlier
  // restart left the row behind. Silence there is how the panel came to claim a phase was working.
  if (recovery.phasesReconciled.length > 0) {
    console.warn(
      `[boot] ${recovery.phasesReconciled.length} phase(s) were left running and are pending again`,
    );
  }

  // 4. Workspace layout (RT-02, §11.1 step 4): the loaders and the scaffolder assume it exists.
  const layout = await ensureWorkspaceLayout(config.workspace);
  console.log(
    `[boot] workspace ${config.workspace} (${config.workspaceMode})` +
      (layout.created.length > 0 ? `: created ${layout.created.join(", ")}` : "") +
      (layout.gitignoreUpdated ? " (.gitignore updated)" : ""),
  );

  // 4b. Agent profiles and policy packs: the builtin library layered under the workspace
  // (AP-01..03, BA-01, DESIGN §2).
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
      (agentsReport.fromWorkspace > 0 ? ` (${agentsReport.fromWorkspace} from the workspace)` : ""),
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

  // 5b. Curated knowledge and the vault, before the orchestrator: a run's prompt and its
  // environment are built from them (KB-04, §18).
  const knowledge = new KnowledgeLoader(config.workspace);
  const knowledgeReport = await knowledge.load();
  console.log(`[boot] knowledge: ${knowledgeReport.loaded} base(s)`);
  for (const bad of knowledgeReport.rejected) {
    console.warn(`[boot] rejected knowledge base ${bad.dir}: ${bad.error}`);
  }
  const vault = new Vault(config.workspace);

  // 5c. Orchestrator: owns chains, project locks and the concurrency cap (OR-*, SR-07).
  // Nothing resumes on its own after a restart (RT-07).
  const orchestrator = new Orchestrator(config, repos, bus, agents, undefined, undefined, health, {
    knowledge,
    vault,
  });

  // 5d. Templates and the phase layer (TP, §16).
  const templates = new TemplatesLoader(
    config.workspace,
    // A disabled profile makes every template that names it unusable, with the reason
    // visible in the library rather than at launch time (AP-07, TP-03).
    (id) => agents.profile(id)?.enabled === true,
    (report) => {
      console.log(`[templates] reloaded: ${report.loaded}`);
      for (const bad of report.rejected) {
        console.warn(`[templates] rejected ${bad.file}: ${bad.error}`);
      }
      repos.events.append({
        type: "config.changed",
        payload: { kind: "template", id: "*", actor: "system" },
      });
      bus.emit("overview");
    },
  );
  const templatesReport = await templates.load();
  console.log(`[boot] templates: ${templatesReport.loaded} usable`);
  for (const bad of templatesReport.rejected) {
    console.warn(`[boot] rejected template ${bad.file}: ${bad.error}`);
  }
  templates.startWatching(config.watchPollMs);

  const phases = new PhaseService(config, repos, bus, agents, orchestrator);
  orchestrator.setPhaseHooks({
    onTaskClosed: (taskId) => phases.onTaskClosed(taskId),
    onGateAnswered: (doubt, choice) => phases.onGateAnswered(doubt, choice),
  });

  // 5d. Preview servers (PV-01..03). The rows describe processes the previous container owned, so
  // a restart invalidates every one of them before anything is offered as a link that loads.
  const previews = new PreviewManager(config, repos, bus);
  const previewsClosed = previews.reconcileAtBoot();
  if (previewsClosed > 0) {
    console.log(`[boot] previews: ${previewsClosed} closed (the container restarted)`);
  }
  previews.startReaper();

  // 5e. The one entry point both surfaces mutate through (§12.0).
  const actions = new Actions({
    config,
    repos,
    agents,
    orchestrator,
    templates,
    knowledge,
    vault,
    phases,
    // OR-11: so a launch onto an engine that is not authenticated is refused, not attempted.
    health,
    previews,
  });

  // 5c. Interactive engine logins driven from the browser (SU-04).
  const loginFlows = new LoginFlows(health);

  // 6. HTTP: panel, health, setup wizard and /mcp (the read-only JSON API lands in phase 7).
  const app = await createHttpServer({
    config,
    bus,
    health,
    repos,
    loginFlows,
    agents,
    checkDatabase: () => checkDatabase(db),
    mcp: {
      config,
      repos,
      agents,
      health,
      orchestrator,
      doubts: new DoubtService(config, repos, bus, agents),
      templates,
      knowledge,
      vault,
      phases,
      actions,
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

  // 8. Last line of defence (RT-07). Node's default for an unhandled rejection is to kill the
  // process, and for a system meant to run unattended that is the worst possible response to a
  // library rejecting a promise nobody awaited: every other project's chain dies with it and the
  // user is left with a container that restarted and a chain paused for no stated reason. This is
  // not a licence to let errors go unhandled — each one is a bug to fix where it happens — but
  // the orchestrator staying up is worth more than a clean exit.
  const survive = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[${kind}] ${detail}`);
    try {
      repos.events.append({
        type: "system",
        payload: { reason: kind, detail: detail.split("\n").slice(0, 4).join(" | ") },
      });
    } catch {
      // The database is what we would have used to report this. Stderr already has it.
    }
  };
  process.on("unhandledRejection", survive("unhandledRejection"));
  process.on("uncaughtException", survive("uncaughtException"));
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
