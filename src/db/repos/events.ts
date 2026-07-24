/**
 * Events repository: append-only timeline that powers the panel and history
 * (DB-02, OB-01). The autoincrement id doubles as the SSE Last-Event-ID cursor.
 */
import type { Db } from "../db.js";
import type { EventRow, EventType } from "../types.js";
import { nowIso } from "../../ids.js";

export type AppendEvent = {
  /** NULL for system-level events. */
  runId?: string | null;
  type: EventType | string;
  payload?: unknown;
  ts?: string;
};

export class EventsRepo {
  constructor(private readonly db: Db) {}

  append(input: AppendEvent): EventRow {
    const result = this.db
      .prepare("INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)")
      .run(
        input.runId ?? null,
        input.ts ?? nowIso(),
        input.type,
        JSON.stringify(input.payload ?? {}),
      );
    return this.getOrThrow(Number(result.lastInsertRowid));
  }

  get(id: number): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
  }

  getOrThrow(id: number): EventRow {
    const row = this.get(id);
    if (!row) throw new Error(`event not found: ${id}`);
    return row;
  }

  /** Run timeline, paginated forward by cursor (WP-03 replay after reconnect). */
  listByRun(runId: string, opts: { after?: number; limit?: number } = {}): EventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    return this.db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(runId, opts.after ?? 0, limit) as EventRow[];
  }

  /** Everything after a cursor, any run: the SSE gap-filling read. */
  listAfter(cursor: number, limit = 500): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?")
      .all(cursor, Math.min(Math.max(limit, 1), 2000)) as EventRow[];
  }

  /**
   * Last action shown on the panel (WP-05): most recent activity event of a run.
   * Inactivity is now - ts of this row.
   */
  lastAction(runId: string): EventRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM events
         WHERE run_id = ?
           AND (type IN ('agent.message','tool.call','file.edit') OR type LIKE 'verify.%')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as EventRow | undefined;
  }

  latestId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as {
      id: number;
    };
    return row.id;
  }

  /** Retention pruning (DB-04). Returns the number of deleted rows. */
  pruneOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    return result.changes;
  }
}
