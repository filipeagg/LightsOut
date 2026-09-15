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

/**
 * What this provider is actually able to do right now (§11.3b).
 *
 * `auth` answers one question — is there a credential — and the last sessions showed how little
 * that proves: `/health` reported both engines authenticated while runs died in their first
 * seconds, so the operator's real test became "does it get past ten seconds", which is not
 * something the panel or an MCP client can read. A provider correctly logged in but out of
 * credit is a different state from one that is not logged in, and until now they were the same.
 *
 * `unknown` is the honest answer before anything has been observed, and it is deliberately not
 * `ok`: nothing has demonstrated that this provider works, and saying otherwise is the mistake
 * this type exists to stop repeating.
 */
export type EngineState = "ok" | "unknown" | "auth_required" | "no_credit" | "rate_limited";

/** What a run last observed about a provider, which outranks any status command (§11.3b). */
type ObservedFailure = {
  state: Exclude<EngineState, "ok" | "unknown">;
  detail: string;
  since: string;
  /** When the provider itself named a moment to try again (§6.9). */
  retryAfter?: string;
};

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
  /** What the engine said when it last refused to work, if it did (§11.3). */
  authError?: string;
  /** What this provider can do right now, as opposed to whether it has a credential (§11.3b). */
  state: EngineState;
  /** The provider's own words for why it is in that state. */
  stateDetail?: string;
  /** When the state was last observed, so a stale reading is visible as stale. */
  stateSince?: string;
  /** When the provider said to come back, when it said (§6.9). */
  retryAfter?: string;
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
    // A credential is not a working provider. `engines()` replaces this with what a run actually
    // observed, and until a run has observed anything the honest answer is "unknown" (§11.3b).
    state: authSource === null ? "auth_required" : "unknown",
    checkedAt: new Date().toISOString(),
  };
}

export class HealthProbe {
  private cache: EngineHealth[] | null = null;
  private cachedAt = 0;
  private readonly startedAt = new Date();
  /** Engines that refused to work for real, whatever their status command claims (§11.3). */
  private readonly failures = new Map<EngineName, ObservedFailure>();
  /** Engines a run has demonstrably driven to completion, which is the only proof of `ok`. */
  private readonly lastOk = new Map<EngineName, string>();

  constructor(
    private readonly config: Config,
    private readonly version: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Invalidate the cache (used when an adapter reports AUTH_REQUIRED, §11.3). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * A run just died on this engine's credentials (§11.3).
   *
   * The status commands are not enough on their own: `claude auth status` happily reports
   * `loggedIn: true` while the OAuth token behind it has expired, and the failure only shows up
   * when a real request is made. So the observed failure wins over the probe until someone
   * reconnects — that is what puts the engine in the panel's attention strip (OB-03).
   */
  noteAuthFailure(engine: EngineName, detail: string): void {
    this.noteFailure(engine, "auth_required", detail);
  }

  /**
   * A run observed this provider refusing to work, and said why (§11.3b).
   *
   * The same reasoning as `noteAuthFailure`, widened: being out of credit or rate-limited is
   * invisible to a status command too, and the operator needs to tell those apart from a dead
   * credential — the first two are a billing page, the third is a reconnect.
   */
  noteFailure(
    engine: EngineName,
    state: ObservedFailure["state"],
    detail: string,
    retryAfterMs?: number,
  ): void {
    const observed: ObservedFailure = {
      state,
      detail: detail.slice(0, 300),
      since: new Date().toISOString(),
    };
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      observed.retryAfter = new Date(Date.now() + retryAfterMs).toISOString();
    }
    this.failures.set(engine, observed);
    this.lastOk.delete(engine);
    this.invalidate();
  }

  /** Called when a login completes or a run succeeds: the engine is demonstrably working. */
  clearAuthFailure(engine: EngineName): void {
    this.lastOk.set(engine, new Date().toISOString());
    if (this.failures.delete(engine)) this.invalidate();
    else this.cache = null;
  }

  async engines(force = false): Promise<EngineHealth[]> {
    const fresh = Date.now() - this.cachedAt < CACHE_TTL_MS;
    if (!force && this.cache && fresh) return this.cache;

    const probed = await Promise.all([
      probeEngine("claude", this.config.adapterClaude, this.env),
      probeEngine("codex", this.config.adapterCodex, this.env),
    ]);
    const engines = probed.map((probe): EngineHealth => {
      const failure = this.failures.get(probe.engine);
      if (!failure) {
        // A credential and no observed failure is not proof of anything until a run has
        // finished on this provider; `unknown` says so out loud (§11.3b).
        const ok = this.lastOk.get(probe.engine);
        if (probe.state === "auth_required") return probe;
        return ok ? { ...probe, state: "ok", stateSince: ok } : probe;
      }
      // Only a dead credential makes `auth` false: an account out of credit is authenticated,
      // and reporting it as logged out sends the operator to the wrong page (§11.3b).
      const authGone = failure.state === "auth_required";
      return {
        ...probe,
        ...(authGone ? { auth: false, authSource: null, authError: failure.detail } : {}),
        state: failure.state,
        stateDetail: failure.detail,
        stateSince: failure.since,
        ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      };
    });

    // Re-probe on failure: only a fully healthy result is cached.
    const allGood = engines.every((e) => e.detected && e.auth && e.state !== "no_credit");
    this.cache = engines;
    this.cachedAt = allGood ? Date.now() : 0;
    return engines;
  }

  async snapshot(dbOk: boolean, dbError?: string): Promise<SystemHealth> {
    const engines = await this.engines();
    // A provider with no credit left is not healthy, however good its credential is (§11.3b).
    const healthy =
      dbOk && engines.every((e) => e.detected && e.auth && e.state !== "no_credit");
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
