/**
 * The models and reasoning levels an engine actually offers (AP-08, DESIGN §5.6).
 *
 * Asked, never assumed. Both ACP adapters answer `session/new` with `configOptions`, and two of
 * them matter here: a select of category `model`, whose values are the models this installation on
 * this account may use, and one of category `thought_level` with the reasoning levels it accepts.
 * A probe spawns the adapter exactly as a run would, opens a session, reads the two selects and
 * stops. No prompt is ever sent, so it costs a process and no tokens.
 *
 * Matched by category and never by id: the adapters name the effort option differently — `effort`
 * on Claude, `reasoning_effort` on Codex — and the category is what the protocol defines. The id
 * is still carried, because setting the option later needs the adapter's own name for it (§6.1).
 */
import * as acp from "@agentclientprotocol/sdk";
import { spawnAdapter } from "../acp/adapter.js";
import { publishCatalog, unpublishCatalog, type EngineId } from "./models.js";

/** The categories the protocol defines for the two selects we care about. */
export const MODEL_CATEGORY = "model";
export const THOUGHT_CATEGORY = "thought_level";

/** Just the part of an ACP config option this module reads. */
export type ConfigOptionLike = {
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
};

/** One select, reduced to what a caller needs to validate a value or set it. */
export type SelectOption = {
  /** The adapter's own id for this option, which `session/set_config_option` needs. */
  id: string;
  values: string[];
  current: string | null;
};

export type EngineSelects = {
  model: SelectOption | null;
  reasoning: SelectOption | null;
};

export type EngineCatalog = EngineSelects & {
  engine: EngineId;
  checkedAt: string;
  /** Why the probe produced nothing, when it produced nothing. */
  error?: string;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const v = (entry as { value?: unknown })?.value;
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/**
 * Pull the two selects out of a `session/new` response. Pure, so the mapping is testable without
 * an adapter — which matters, because the mapping is where a protocol change would bite first.
 */
export function readSelects(configOptions: unknown): EngineSelects {
  const list: ConfigOptionLike[] = Array.isArray(configOptions) ? configOptions : [];
  const pick = (category: string): SelectOption | null => {
    const found = list.find((o) => o?.category === category && o?.type === "select");
    if (!found || typeof found.id !== "string") return null;
    const values = asStringArray(found.options);
    if (values.length === 0) return null;
    return {
      id: found.id,
      values,
      current: typeof found.currentValue === "string" ? found.currentValue : null,
    };
  };
  return { model: pick(MODEL_CATEGORY), reasoning: pick(THOUGHT_CATEGORY) };
}

export type ProbeInput = {
  engine: EngineId;
  /** The adapter command, the same string a run would spawn (LO_ADAPTER_*). */
  command: string;
  /** A directory the adapter may open a session in. The probe writes nothing. */
  cwd: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ask one engine what it offers. Never throws: an engine that is missing, unauthenticated or
 * simply broken is a catalog with an `error` and no selects, and the caller falls back to the
 * static table (§5.6). A probe that hangs is the same as one that failed.
 */
export async function probeEngineCatalog(input: ProbeInput): Promise<EngineCatalog> {
  const checkedAt = new Date().toISOString();
  const base = { engine: input.engine, checkedAt, model: null, reasoning: null };

  let adapter: ReturnType<typeof spawnAdapter> | undefined;
  try {
    adapter = spawnAdapter({ command: input.command, cwd: input.cwd });
    const stream = adapter.stream;
    const work = acp.client({ name: "lightsout" }).connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return ctx
        .buildSession(input.cwd)
        .withSession(async (session) => session.newSessionResponse);
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("catalog probe timed out")),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    });
    let response: { configOptions?: unknown };
    try {
      response = (await Promise.race([work, timeout])) as { configOptions?: unknown };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const selects = readSelects(response?.configOptions);
    return { ...base, ...selects };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await adapter?.stop(2000).catch(() => undefined);
  }
}

/**
 * The cache in front of the probe. Held beside the health cache and invalidated for the same
 * reasons (§11.3): an engine whose credentials just failed has nothing trustworthy to say about
 * its catalog either.
 */
export class EngineCatalogs {
  private readonly cache = new Map<EngineId, EngineCatalog>();
  private readonly inFlight = new Map<EngineId, Promise<EngineCatalog>>();
  private readonly cachedAt = new Map<EngineId, number>();

  constructor(
    private readonly adapterFor: (engine: EngineId) => string,
    private readonly cwd: string,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  /** Forget what an engine said. No argument forgets every engine. */
  invalidate(engine?: EngineId): void {
    if (engine) {
      this.cache.delete(engine);
      this.cachedAt.delete(engine);
    } else {
      this.cache.clear();
      this.cachedAt.clear();
    }
    unpublishCatalog(engine);
  }

  /** What this engine offers, probing at most once per TTL and never twice concurrently. */
  async get(engine: EngineId, force = false): Promise<EngineCatalog> {
    const fresh = Date.now() - (this.cachedAt.get(engine) ?? 0) < this.ttlMs;
    const cached = this.cache.get(engine);
    if (!force && cached && fresh) return cached;

    const existing = this.inFlight.get(engine);
    if (existing) return existing;

    const run = probeEngineCatalog({
      engine,
      command: this.adapterFor(engine),
      cwd: this.cwd,
    })
      .then((catalog) => {
        this.cache.set(engine, catalog);
        // Only a probe that actually learned something is cached and published: a failure must be
        // retried, and must not overwrite a good answer with silence.
        if (catalog.model || catalog.reasoning) {
          this.cachedAt.set(engine, Date.now());
          publishCatalog(engine, {
            models: catalog.model?.values ?? [],
            reasoning: catalog.reasoning?.values ?? [],
            currentModel: catalog.model?.current ?? null,
            currentReasoning: catalog.reasoning?.current ?? null,
          });
        } else {
          this.cachedAt.set(engine, 0);
          unpublishCatalog(engine);
        }
        return catalog;
      })
      .finally(() => {
        this.inFlight.delete(engine);
      });

    this.inFlight.set(engine, run);
    return run;
  }

  /** The last answer without probing, for callers that must not block (the run path). */
  peek(engine: EngineId): EngineCatalog | undefined {
    return this.cache.get(engine);
  }
}
