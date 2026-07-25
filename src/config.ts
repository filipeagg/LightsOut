/**
 * Single source of truth for runtime configuration (DESIGN §3.4).
 * Parsed once at boot; invalid configuration aborts startup with a readable error.
 */
import { z } from "zod";

const intFromEnv = (fallback: number, min = 1) =>
  z.coerce.number().int().min(min).default(fallback);

const schema = z.object({
  bind: z.string().min(1).default("0.0.0.0"),
  port: intFromEnv(8484),
  dbPath: z.string().min(1).default("/data/lightsout.db"),
  workspace: z.string().min(1).default("/workspace"),
  /** `host` = bind-mounted user folder (RT-02 default), `volume` = managed volume (headless). */
  workspaceMode: z.enum(["host", "volume"]).default("host"),
  /** Loader poll interval: bind mounts do not deliver reliable inotify events (AP-03). */
  watchPollMs: intFromEnv(2000, 250),
  maxParallel: intFromEnv(3),
  timeoutQuickMin: intFromEnv(30),
  timeoutFullMin: intFromEnv(90),
  inactivityMin: intFromEnv(8),
  permissionWaitHours: intFromEnv(24),
  advisorConfidence: z.coerce.number().min(0).max(1).default(0.7),
  eventRetentionDays: intFromEnv(90),
  adapterClaude: z.string().min(1).default("claude-agent-acp"),
  adapterCodex: z.string().min(1).default("codex-acp"),
  /** "proxy" when the egress allowlist overlay is active, "unrestricted" otherwise (RT-05). */
  egress: z.enum(["proxy", "unrestricted"]).default("unrestricted"),
});

export type Config = z.infer<typeof schema>;

function raw(env: NodeJS.ProcessEnv) {
  return {
    bind: env.LO_BIND,
    port: env.LO_PORT_INTERNAL ?? "8484",
    dbPath: env.LO_DB,
    workspace: env.LO_WORKSPACE,
    workspaceMode: env.LO_WORKSPACE_MODE,
    watchPollMs: env.LO_WATCH_POLL_MS,
    maxParallel: env.LO_MAX_PARALLEL,
    timeoutQuickMin: env.LO_TIMEOUT_QUICK_MIN,
    timeoutFullMin: env.LO_TIMEOUT_FULL_MIN,
    inactivityMin: env.LO_INACTIVITY_MIN,
    permissionWaitHours: env.LO_PERMISSION_WAIT_HOURS,
    advisorConfidence: env.LO_ADVISOR_CONFIDENCE,
    eventRetentionDays: env.LO_EVENT_RETENTION_DAYS,
    adapterClaude: env.LO_ADAPTER_CLAUDE,
    adapterCodex: env.LO_ADAPTER_CODEX,
    egress: env.LO_EGRESS,
  };
}

/** Drop undefined/empty values so zod defaults apply. */
function clean(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined && v !== ""),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(clean(raw(env)));
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}
