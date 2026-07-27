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
  /**
   * The same workspace as the user sees it on their own machine, when it is a bind mount
   * (PM-10). Reported next to the container path so a person can open a file in their editor;
   * empty means "unknown", which is answered as null rather than guessed.
   */
  workspaceHost: z.string().default(""),
  /** Loader poll interval: bind mounts do not deliver reliable inotify events (AP-03). */
  watchPollMs: intFromEnv(2000, 250),
  maxParallel: intFromEnv(3),
  timeoutQuickMin: intFromEnv(30),
  timeoutFullMin: intFromEnv(90),
  inactivityMin: intFromEnv(8),
  permissionWaitHours: intFromEnv(24),
  /**
   * How long an **unattended** run waits on a hard-floor gate before giving up (OR-12, §7.7).
   *
   * 24 hours is the right answer when somebody is going to look. When nobody is, it is the whole
   * failure: one run sat 5 h 29 min on a single gate and produced nothing, where the same run
   * refused at thirty minutes would have recorded the gap and delivered the rest.
   */
  unattendedWaitMin: intFromEnv(30, 1),
  advisorConfidence: z.coerce.number().min(0).max(1).default(0.7),
  /** How much curated knowledge one prompt may carry (KB-06, DESIGN §17.2). */
  knowledgeBudgetChars: intFromEnv(120000, 0),
  /**
   * How many bytes of a script body are read to classify it (PE-07, DESIGN §7.1). A script
   * larger than this is never `script_exec`: it reaches a human instead.
   */
  scriptScanBytes: intFromEnv(65536, 1024),
  eventRetentionDays: intFromEnv(90),
  /**
   * The loopback port pool published for preview servers (PV-01), and how long one lives without
   * being stopped (PV-03). The range must match the `ports:` line in compose: a port published
   * there but not offered here is unused, and one offered here but not published is a preview the
   * user's browser cannot reach.
   */
  previewPortFrom: intFromEnv(5170, 1024),
  previewPortTo: intFromEnv(5189, 1024),
  previewTtlMin: intFromEnv(120, 1),
  /** Where preview processes are managed from; empty disables the feature in this process. */
  toolchainsRoot: z.string().default("/toolchains"),
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
    workspaceHost: env.LO_WORKSPACE_HOST,
    watchPollMs: env.LO_WATCH_POLL_MS,
    maxParallel: env.LO_MAX_PARALLEL,
    timeoutQuickMin: env.LO_TIMEOUT_QUICK_MIN,
    timeoutFullMin: env.LO_TIMEOUT_FULL_MIN,
    inactivityMin: env.LO_INACTIVITY_MIN,
    permissionWaitHours: env.LO_PERMISSION_WAIT_HOURS,
    unattendedWaitMin: env.LO_UNATTENDED_WAIT_MIN,
    advisorConfidence: env.LO_ADVISOR_CONFIDENCE,
    knowledgeBudgetChars: env.LO_KNOWLEDGE_BUDGET_CHARS,
    scriptScanBytes: env.LO_SCRIPT_SCAN_BYTES,
    eventRetentionDays: env.LO_EVENT_RETENTION_DAYS,
    previewPortFrom: env.LO_PREVIEW_PORT_FROM,
    previewPortTo: env.LO_PREVIEW_PORT_TO,
    previewTtlMin: env.LO_PREVIEW_TTL_MIN,
    toolchainsRoot: env.LO_TOOLCHAINS_ROOT,
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
