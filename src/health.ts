/**
 * Engine detection and auth probing (RT-04, RT-06, DESIGN §11.1 step 5).
 *
 * Detection = the ACP adapter command is resolvable on PATH.
 * Auth       = the engine CLI's own status command says so (`claude auth status`,
 *              `codex login status`), with credential-artifact presence as fallback
 *              when the CLI cannot be run. Both status commands are local and cheap.
 * The probe never reads secret values, so it cannot leak credentials (NF-02).
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
  {
    /** CLI status command: [command, ...args]. */
    statusCommand: string[];
    credentialFiles: string[];
    apiKeyEnv: string[];
  }
> = {
  claude: {
    statusCommand: ["claude", "auth", "status"],
    credentialFiles: [".claude/.credentials.json", ".claude/credentials.json"],
    apiKeyEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  codex: {
    statusCommand: ["codex", "login", "status"],
    credentialFiles: [".codex/auth.json"],
    apiKeyEnv: ["OPENAI_API_KEY"],
  },
};

/**
 * Read the engine CLI's own auth status.
 * Returns null when the CLI cannot be run, so the caller can fall back.
 */
async function cliAuthStatus(
  engine: EngineName,
  command: string[],
): Promise<EngineHealth["authSource"] | "none" | null> {
  const [bin, ...args] = command;
  if (!bin) return null;
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 8000,
      maxBuffer: 256 * 1024,
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    // Both CLIs exit non-zero in some "not logged in" states; use their output.
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    if (e.stdout === undefined && e.stderr === undefined) return null;
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  if (engine === "claude") {
    // `claude auth status` prints JSON: { loggedIn, authMethod, apiProvider }.
    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as {
        loggedIn?: boolean;
        authMethod?: string;
      };
      if (parsed.loggedIn !== true) return "none";
      return parsed.authMethod === "apiKey" ? "api_key" : "subscription";
    } catch {
      return null;
    }
  }

  // `codex login status` prints "Not logged in" or a description of the method.
  const text = output.toLowerCase();
  if (text.includes("not logged in")) return "none";
  if (text.includes("api key")) return "api_key";
  if (text.includes("logged in")) return "subscription";
  return null;
}

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
  const fromCli = await cliAuthStatus(engine, spec.statusCommand);
  if (fromCli === "subscription" || fromCli === "api_key") {
    authSource = fromCli;
  } else if (fromCli === null) {
    // CLI unavailable: fall back to credential artifacts and API keys.
    for (const rel of spec.credentialFiles) {
      if (await nonEmptyFile(path.join(homedir(), rel))) {
        authSource = "subscription";
        break;
      }
    }
    if (!authSource && spec.apiKeyEnv.some((k) => (env[k] ?? "").length > 0)) {
      authSource = "api_key";
    }
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
