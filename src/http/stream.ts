/**
 * Server-sent events (WP-03, DESIGN §12.2).
 *
 * The bus only says "something changed" (§1); the facts always come back out of SQLite, so a
 * dropped notification can never leave the panel showing something that never happened. The
 * `events.id` autoincrement is the cursor: every frame carries it as its SSE `id:`, and a
 * reconnect replays the rows past `Last-Event-ID` before resuming live — no gap, no duplicate.
 *
 * Three named events: `overview` (debounced, the whole global read model), `run:<runId>` (one
 * timeline row) and `doubt`. A comment every 15 s keeps proxies and browsers from timing out.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Repos } from "../db/repos/index.js";
import type { HealthProbe } from "../health.js";
import { overviewView } from "../views.js";

export type StreamDeps = {
  config: Config;
  bus: Bus;
  repos: Repos;
  health: HealthProbe;
};

const KEEPALIVE_MS = 15_000;
/** The overview is a whole read model; coalescing bursts keeps a chatty run from flooding it. */
const OVERVIEW_DEBOUNCE_MS = 500;
/** Timeline rows are cheap and the user is watching them tick, so they coalesce barely at all. */
const TIMELINE_DEBOUNCE_MS = 120;
/** Cap on a single replay: a browser left closed for a week must not get the whole table. */
const REPLAY_LIMIT = 1000;

function parseCursor(request: FastifyRequest): number | null {
  const header = request.headers["last-event-id"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = (request.query as { lastEventId?: string } | undefined)?.lastEventId;
  const raw = fromHeader ?? fromQuery;
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function registerStreamRoute(app: FastifyInstance, deps: StreamDeps): void {
  const { bus, repos, health } = deps;
  const views = { config: deps.config, repos };

  app.get("/api/stream", async (request, reply) => {
    reply.hijack();
    const raw: FastifyReply["raw"] = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Fastify sits behind nothing here, but a user's reverse proxy might buffer otherwise.
      "x-accel-buffering": "no",
    });

    let closed = false;
    const frame = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      const head = id === undefined ? "" : `id: ${id}\n`;
      raw.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /** Send one timeline row under its run's event name. */
    const sendRow = (row: { id: number; run_id: string | null; ts: string; type: string; payload: string }) => {
      frame(
        row.run_id ? `run:${row.run_id}` : "system",
        {
          id: row.id,
          runId: row.run_id,
          ts: row.ts,
          type: row.type,
          payload: JSON.parse(row.payload) as unknown,
        },
        row.id,
      );
    };

    // Replay first, so a reconnecting browser is caught up before anything live arrives.
    const requested = parseCursor(request);
    let cursor = requested ?? repos.events.latestId();
    if (requested !== null) {
      const missed = repos.events.listAfter(requested, REPLAY_LIMIT);
      for (const row of missed) sendRow(row);
      cursor = missed.at(-1)?.id ?? requested;
      if (missed.length === REPLAY_LIMIT) {
        // Honest about the truncation rather than pretending the gap was filled.
        frame("truncated", { from: requested, to: cursor, note: "replay capped; re-fetch the views" });
      }
    }

    let timelineTimer: NodeJS.Timeout | null = null;
    const flushTimeline = () => {
      timelineTimer = null;
      const rows = repos.events.listAfter(cursor, REPLAY_LIMIT);
      for (const row of rows) sendRow(row);
      cursor = rows.at(-1)?.id ?? cursor;
    };
    const scheduleTimeline = () => {
      if (closed || timelineTimer) return;
      timelineTimer = setTimeout(flushTimeline, TIMELINE_DEBOUNCE_MS);
    };

    let overviewTimer: NodeJS.Timeout | null = null;
    const sendOverview = () => {
      overviewTimer = null;
      void (async () => {
        try {
          frame("overview", overviewView(views, await health.engines()), cursor);
        } catch (err) {
          app.log.error({ err }, "overview frame failed");
        }
      })();
    };
    const scheduleOverview = () => {
      if (closed || overviewTimer) return;
      overviewTimer = setTimeout(sendOverview, OVERVIEW_DEBOUNCE_MS);
    };

    // A fresh subscriber gets the whole picture immediately; after that it is patches.
    sendOverview();

    const unsubscribe = [
      bus.on("overview", scheduleOverview),
      bus.on("health", scheduleOverview),
      bus.on("run", () => {
        scheduleTimeline();
        scheduleOverview();
      }),
      bus.on("doubt", ({ doubtId }) => {
        const doubt = repos.doubts.get(doubtId);
        if (doubt) frame("doubt", { id: doubt.id, ref: doubt.ref, projectId: doubt.project_id, status: doubt.status }, cursor);
        scheduleOverview();
      }),
    ];

    const keepalive = setInterval(() => {
      if (!closed) raw.write(": keepalive\n\n");
    }, KEEPALIVE_MS);

    raw.on("close", () => {
      closed = true;
      clearInterval(keepalive);
      if (timelineTimer) clearTimeout(timelineTimer);
      if (overviewTimer) clearTimeout(overviewTimer);
      for (const off of unsubscribe) off();
    });

    return reply;
  });
}
