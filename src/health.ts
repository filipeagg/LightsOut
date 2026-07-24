/**
 * Engine detection and auth probing (RT-04, RT-06, DESIGN §11.1 step 5).
 *
 * Detection = the ACP adapter command is resolvable on PATH.
 * Auth       = a credential artifact exists for the engine (subscription login
 *              file written by the CLI, or an API key in the environment).
 * The probe never performs a network call and never reads secret values; it only
 * reports presence, so a probe can never leak credentials (NF-02).
 * Results are cached for 10 minutes and re-probed on failure.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 10 * 60 * 1000;

export type EngineName = "claude" | "codex";

export type EngineHealth = {
  engine: EngineName;
  /** Adapter command as configured (LO_ADAPTER_*). */
  adapter: string;
  /** Adapter command resolvable on PATH. */
  detected: boolean;
  /** A usable credential artifact was found. */
  auth: boolean;
  /** "subscription" | "api_key" | null — how auth was satisfied (NF-03). */
  authSource: "subscription" | "api_key" | null;
  checkedAt: string;
};

export type SystemHealth = {
  status: "ok" | "degraded";
  version: string;
  orchestrator: { running: boolean; startedAt: string; uptimeSec: number };
  database: { path: string; ok: boolean; error?: string };
  engines: EngineHealth[];
  /** Honest signal: "proxy" (allowlist active) or "unrestricted" (RT-05). */
  network: Config["egress"];
};

const ENGINE_SPECS: Record<
  EngineName,
  { credentialFiles: string[]; apiKeyEnv: string[] }
> = {
  claude: {
    credentialFiles: [".claude/.credentials.json", ".claude/credentials.json"],
    apiKeyEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  codex: {
    credentialFiles: [".codex/auth.json"],
    apiKeyEnv: ["OPENAI_API_KEY"],
  },
};

async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    // Resolve only the first token: adapter commands may carry arguments.
    const bin = command.split(/\s+/)[0] ?? command;
    await execFileAsync("sh", ["-lc", `command -v ${JSON.stringify(bin)}`]);
    return true;
  } catch {
    return false;
  }
}

async function nonEmptyFile(file: string): Promise<boolean> {
  try {
    const s = await stat(file);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function probeEngine(
  engine: EngineName,
  adapter: string,
  env: NodeJS.ProcessEnv,
): Promise<EngineHealth> {
  const spec = ENGINE_SPECS[engine];
  const detected = await commandExists(adapter);

  let authSource: EngineHealth["authSource"] = null;
  for (const rel of spec.credentialFiles) {
    if (await nonEmptyFile(path.join(homedir(), rel))) {
      authSource = "subscription";
      break;
    }
  }
  if (!authSource && spec.apiKeyEnv.some((k) => (env[k] ?? "").length > 0)) {
    authSource = "api_key";
  }

  return {
    engine,
    adapter,
    detected,
    auth: authSource !== null,
    authSource,
    checkedAt: new Date().toISOString(),
  };
}

export class HealthProbe {
  private cache: EngineHealth[] | null = null;
  private cachedAt = 0;
  private readonly startedAt = new Date();

  constructor(
    private readonly config: Config,
    private readonly version: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Invalidate the cache (used when an adapter reports AUTH_REQUIRED, §11.3). */
  invalidate(): void {
    this.cache = null;
  }

  async engines(force = false): Promise<EngineHealth[]> {
    const fresh = Date.now() - this.cachedAt < CACHE_TTL_MS;
    if (!force && this.cache && fresh) return this.cache;

    const engines = await Promise.all([
      probeEngine("claude", this.config.adapterClaude, this.env),
      probeEngine("codex", this.config.adapterCodex, this.env),
    ]);

    // Re-probe on failure: only a fully healthy result is cached.
    const allGood = engines.every((e) => e.detected && e.auth);
    this.cache = engines;
    this.cachedAt = allGood ? Date.now() : 0;
    return engines;
  }

  async snapshot(dbOk: boolean, dbError?: string): Promise<SystemHealth> {
    const engines = await this.engines();
    const healthy = dbOk && engines.every((e) => e.detected && e.auth);
    return {
      status: healthy ? "ok" : "degraded",
      version: this.version,
      orchestrator: {
        running: true,
        startedAt: this.startedAt.toISOString(),
        uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      },
      database: dbError
        ? { path: this.config.dbPath, ok: dbOk, error: dbError }
        : { path: this.config.dbPath, ok: dbOk },
      engines,
      network: this.config.egress,
    };
  }
}
