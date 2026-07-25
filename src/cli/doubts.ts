/**
 * Maintenance entry point: list and answer doubts before MCP lands in phase 6.
 *
 *   node dist/cli/doubts.js list [--project <slug>]
 *   node dist/cli/doubts.js answer --doubt D-3 --project <slug> --choice A [--note "..."]
 *
 * Answering a functional doubt requeues its task; the chain then continues in the long-lived
 * container process, not here. This CLI is for inspection and for unblocking.
 */
import { loadConfig } from "../config.js";
import { createBus } from "../bus.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createRepos } from "../db/repos/index.js";
import { AgentsLoader } from "../agents/loader.js";
import { DoubtService } from "../orchestrator/doubts.js";

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
  const command = process.argv[2] ?? "list";
  const config = loadConfig();
  const db = openDb({ file: config.dbPath });
  migrate(db);
  const repos = createRepos(db);
  const agents = new AgentsLoader(config.workspace);
  await agents.load();
  const doubts = new DoubtService(config, repos, createBus(), agents);

  if (command === "list") {
    const project = process.argv.includes("--project") ? arg("project") : undefined;
    const rows = repos.doubts.listOpen(project);
    console.log(
      JSON.stringify(
        rows.map((d) => ({
          ref: d.ref,
          id: d.id,
          project: d.project_id,
          kind: d.kind,
          context: d.context,
          blocks: d.blocks,
          options: repos.doubts.options(d),
          recommendation: d.recommendation,
          secondOpinion: repos.doubts.secondOpinion(d),
          ageMin: Math.round((Date.now() - new Date(d.created_at).getTime()) / 60000),
        })),
        null,
        2,
      ),
    );
    db.close();
    return;
  }

  if (command === "answer") {
    const result = await doubts.answer({
      doubtId: arg("doubt"),
      choice: arg("choice"),
      ...(process.argv.includes("--note") ? { note: arg("note") } : {}),
      ...(process.argv.includes("--project") ? { projectId: arg("project") } : {}),
    });
    console.log(
      JSON.stringify(
        { ref: result.doubt.ref, status: result.doubt.status, answer: result.doubt.answer },
        null,
        2,
      ),
    );
    db.close();
    return;
  }

  throw new Error(`unknown command: ${command} (expected list or answer)`);
}

main().catch((err: unknown) => {
  console.error("[cli] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
