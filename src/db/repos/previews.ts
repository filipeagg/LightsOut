/**
 * Preview servers (PV-01..03, DESIGN §21).
 *
 * A table rather than a map in memory, for two reasons: the panel and MCP must read one truth
 * about what is running, and a preview left behind by a crash has to be visible rather than merely
 * leaked. Rows describe processes this container owns, so a restart invalidates all of them and
 * the boot pass says so.
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type PreviewStatus = "running" | "stopped" | "exited" | "expired";

export type PreviewRow = {
  id: string;
  project_id: string;
  port: number;
  command: string;
  /** What was actually run after §21.3 normalisation, when it differs from `command`. */
  normalised: string | null;
  cwd: string;
  pid: number | null;
  log_path: string;
  status: PreviewStatus;
  started_by: string;
  started_at: string;
  expires_at: string | null;
  ended_at: string | null;
  exit_reason: string | null;
};

export class PreviewsRepo {
  constructor(private readonly db: Db) {}

  start(input: {
    projectId: string;
    port: number;
    command: string;
    normalised?: string | null;
    cwd: string;
    pid: number | null;
    logPath: string;
    startedBy: string;
    expiresAt: string | null;
  }): PreviewRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO previews
           (id, project_id, port, command, normalised, cwd, pid, log_path, status,
            started_by, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.port,
        input.command,
        input.normalised ?? null,
        input.cwd,
        input.pid,
        input.logPath,
        input.startedBy,
        nowIso(),
        input.expiresAt,
      );
    return this.getOrThrow(id);
  }

  get(id: string): PreviewRow | undefined {
    return this.db.prepare("SELECT * FROM previews WHERE id = ?").get(id) as
      | PreviewRow
      | undefined;
  }

  getOrThrow(id: string): PreviewRow {
    const row = this.get(id);
    if (!row) throw new Error(`preview not found: ${id}`);
    return row;
  }

  /** Everything still claiming to run, oldest first: what the reaper and the boot pass walk. */
  listRunning(projectId?: string): PreviewRow[] {
    return projectId
      ? (this.db
          .prepare(
            "SELECT * FROM previews WHERE status = 'running' AND project_id = ? ORDER BY started_at",
          )
          .all(projectId) as PreviewRow[])
      : (this.db
          .prepare("SELECT * FROM previews WHERE status = 'running' ORDER BY started_at")
          .all() as PreviewRow[]);
  }

  list(projectId: string, limit = 20): PreviewRow[] {
    return this.db
      .prepare("SELECT * FROM previews WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(projectId, limit) as PreviewRow[];
  }

  /** Ports currently claimed, so the allocator does not hand out one that is in use. */
  portsInUse(): Set<number> {
    const rows = this.db
      .prepare("SELECT port FROM previews WHERE status = 'running'")
      .all() as { port: number }[];
    return new Set(rows.map((row) => row.port));
  }

  finish(id: string, status: Exclude<PreviewStatus, "running">, reason: string): PreviewRow {
    this.db
      .prepare("UPDATE previews SET status = ?, ended_at = ?, exit_reason = ? WHERE id = ?")
      .run(status, nowIso(), reason, id);
    return this.getOrThrow(id);
  }

  /** Rows for a project that is going away (PM-08). */
  removeForProject(projectId: string): number {
    return this.db.prepare("DELETE FROM previews WHERE project_id = ?").run(projectId).changes;
  }
}
