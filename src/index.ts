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

  // 2-3. TODO(phase 2/4): open DB + migrations, then the recovery pass (§11.2).
  const checkDatabase = () => ({ ok: true });

  // 4. TODO(phase 3): load agent profiles and policy packs (AP-01..03).

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

  // 6. HTTP: panel, health (JSON API, SSE and /mcp land in phases 6-7).
  const app = await createHttpServer({ config, bus, health, checkDatabase });
  await app.listen({ host: config.bind, port: config.port });
  console.log(`[boot] listening on http://${config.bind}:${config.port}`);

  // 7. Graceful shutdown (RT-07): cancel work, persist state, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);
    // TODO(phase 3/4): cancel active ACP sessions and persist run state.
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
