/**
 * Maintenance entry point: create a project if needed and run a chain of tasks unattended.
 * Used by scripts/verify/phase4.sh and to drive real work before MCP lands in phase 6.
 *
 * Usage inside the container:
 *   node dist/cli/run-chain.js --project demo --agent builder --chain "Title" \
 *        --task "Title :: spec text" --task "Другой :: spec" [--verify "npm test"]
 */
import { loadConfig } from "../config.js";
import { createBus } from "../bus.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import { createRepos } from "../db/repos/index.js";
import { AgentsLoader } from "../agents/loader.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { createProject } from "../projects/scaffold.js";
import type { PushPolicy, TaskLevel } from "../db/types.js";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required argument --${name}`);
  }
  return value;
}

function args(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((token, index) => {
    if (token !== `--${name}`) return;
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) values.push(value);
  });
  return values;
}

async function main(): Promise<void> {
  // A crashing adapter child must not take the CLI down before it persists the outcome.
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    console.error("[cli] uncaught:", err.message);
  });

  const config = loadConfig();
  const bus = createBus();
  const db = openDb({ file: config.dbPath });
  migrate(db);
  const repos = createRepos(db);

  const agents = new AgentsLoader(config.workspace);
  const report = await agents.load();
  console.log(`[cli] agents: ${report.loaded} profile(s), ${report.packs} pack(s)`);

  const { project, created } = await createProject(repos, config.workspace, {
    name: arg("project"),
    // PM-09: the CLI is a development entry point, so it fills the brief with what it knows and
    // says where it came from rather than refusing. A real project gets one from a person.
    context: arg(
      "context",
      `status: provisional\nname: ${arg("project")}\nnote: created by run-chain.js (PM-09)`,
    ),
    verify: arg("verify", ""),
    push: arg("push", "manual") as PushPolicy,
    ...(process.argv.includes("--remote") ? { remote: arg("remote") } : {}),
  });
  console.log(`[cli] project ${project.id} (${created ? "created" : "existing"}) at ${project.path}`);

  const verify = arg("verify", "");
  if (verify && project.verify_cmd !== verify) {
    repos.projects.update(project.id, { verifyCmd: verify });
  }

  const level = arg("level", "quick") as TaskLevel;
  const agentId = arg("agent");
  const tasks = args("task").map((entry) => {
    const [title, ...rest] = entry.split("::");
    const spec = rest.join("::").trim();
    return {
      title: (title ?? entry).trim(),
      spec: spec || (title ?? entry).trim(),
      agentId,
      level,
    };
  });
  if (tasks.length === 0) throw new Error("at least one --task is required");

  const orchestrator = new Orchestrator(config, repos, bus, agents);
  // OR-10: the CLI states an expectation for every task, taken from --expects or a sane default,
  // so the development entry point obeys the same contract as the surfaces.
  const expects = arg(
    "expects",
    "The work described in the task, done and verifiable: the files it names, and the verify command green.",
  );
  const launch = orchestrator.launchChain({
    projectId: project.id,
    title: arg("chain", "cli chain"),
    tasks: tasks.map((task) => ({ ...task, expects })),
  });
  console.log(`[cli] chain ${launch.chainId} started=${launch.started} tasks=${launch.taskIds.length}`);

  await orchestrator.idle();

  const chain = repos.chains.getOrThrow(launch.chainId);
  const rows = repos.tasks.listByChain(chain.id);
  console.log(
    JSON.stringify(
      {
        chainId: chain.id,
        chainStatus: chain.status,
        tasks: rows.map((t) => ({ id: t.id, position: t.position, title: t.title, status: t.status })),
        runs: repos.runs
          .history({ projectId: project.id, limit: 20 })
          .map((r) => ({
            id: r.id,
            status: r.status,
            exitReason: r.exit_reason,
            finalCommit: r.final_commit,
          })),
      },
      null,
      2,
    ),
  );

  db.close();
  process.exit(chain.status === "completed" ? 0 : 2);
}

main().catch((err: unknown) => {
  console.error("[cli] fatal:", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
