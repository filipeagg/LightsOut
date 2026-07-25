/**
 * Maintenance entry point: run a single task without the orchestrator or MCP.
 * Used by scripts/verify/phase3.sh and for debugging a profile or a policy pack.
 * The orchestrator (phase 4) drives the same TaskRunner.
 *
 * Usage inside the container:
 *   node dist/cli/run-task.js --project demo --agent builder --title "…" --spec "…" [--level quick]
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { createBus } from "../bus.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createRepos } from "../db/repos/index.js";
import { AgentsLoader } from "../agents/loader.js";
import { TaskRunner } from "../acp/runner.js";
import { slugify } from "../ids.js";
import type { TaskLevel } from "../db/types.js";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bus = createBus();
  const db = openDb({ file: config.dbPath });
  migrate(db);
  const repos = createRepos(db);

  const agents = new AgentsLoader(config.workspace);
  const report = await agents.load();
  console.log(
    `[cli] agents loaded: ${report.loaded} profile(s), ${report.packs} pack(s)`,
  );
  for (const bad of report.rejected) console.warn(`[cli] rejected ${bad.file}: ${bad.error}`);

  const projectId = slugify(arg("project"));
  const projectPath = path.join(config.workspace, "projects", projectId);
  await mkdir(path.join(projectPath, "doc"), { recursive: true });

  const project =
    repos.projects.get(projectId) ??
    repos.projects.create({ id: projectId, name: projectId, path: projectPath });

  const chain =
    repos.chains.activeForProject(project.id) ??
    repos.chains.create({ projectId: project.id, title: "cli" });

  const task = repos.tasks.create({
    chainId: chain.id,
    projectId: project.id,
    title: arg("title"),
    spec: arg("spec"),
    agentId: arg("agent"),
    level: arg("level", "quick") as TaskLevel,
  });

  const runner = new TaskRunner(config, repos, bus, agents);
  const { runId, outcome, doubtRef } = await runner.run({
    project,
    task,
    onStderr: (line) => console.error(`[adapter] ${line}`),
  });

  const audit = repos.audit.countByVerdict(runId);
  console.log(
    JSON.stringify(
      {
        runId,
        status: outcome.status,
        exitReason: outcome.exitReason,
        summary: outcome.summary,
        sentinelMissing: outcome.sentinelMissing,
        tokensIn: outcome.tokensIn ?? null,
        tokensOut: outcome.tokensOut ?? null,
        costUsd: outcome.costUsd ?? null,
        acpSession: outcome.acpSession ?? null,
        doubtRef: doubtRef ?? null,
        permissions: audit,
        events: repos.events.listByRun(runId).length,
      },
      null,
      2,
    ),
  );

  db.close();
  process.exit(outcome.status === "ok" || outcome.status === "doubt" ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("[cli] fatal:", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
