/** Runs repository (SR-05, OR-05, DB-01). */
import type { Db } from "../db.js";
import type { Engine, RunRow, RunStatus } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export type StartRun = {
  taskId: string;
  engine: Engine;
  model?: string | null;
  acpSession?: string | null;
  /** Defaults to the next attempt number for the task (retries, resumes). */
  attempt?: number;
};

export type FinishRun = {
  status: RunStatus;
  exitReason?: string | null;
  summary?: string | null;
  error?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  finalCommit?: string | null;
};

export class RunsRepo {
  constructor(private readonly db: Db) {}

  start(input: StartRun): RunRow {
    const id = ulid();
    const attempt = input.attempt ?? this.nextAttempt(input.taskId);
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, attempt, engine, model, acp_session, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        input.taskId,
        attempt,
        input.engine,
        input.model ?? null,
        input.acpSession ?? null,
        nowIso(),
      );
    return this.getOrThrow(id);
  }

  nextAttempt(taskId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(attempt), 0) AS a FROM runs WHERE task_id = ?")
      .get(taskId) as { a: number };
    return row.a + 1;
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
  }

  getOrThrow(id: string): RunRow {
    const row = this.get(id);
    if (!row) throw new Error(`run not found: ${id}`);
    return row;
  }

  listByTask(taskId: string): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt")
      .all(taskId) as RunRow[];
  }

  /** Runs still occupying a slot: what the recovery pass and SR-07 care about. */
  listActive(): RunRow[] {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE status IN ('running','waiting_human') ORDER BY started_at",
      )
      .all() as RunRow[];
  }

  setStatus(id: string, status: RunStatus, exitReason?: string | null): RunRow {
    this.db
      .prepare("UPDATE runs SET status = ?, exit_reason = COALESCE(?, exit_reason) WHERE id = ?")
      .run(status, exitReason ?? null, id);
    return this.getOrThrow(id);
  }

  setAcpSession(id: string, acpSession: string): RunRow {
    this.db.prepare("UPDATE runs SET acp_session = ? WHERE id = ?").run(acpSession, id);
    return this.getOrThrow(id);
  }

  setWipCommit(id: string, sha: string): RunRow {
    this.db.prepare("UPDATE runs SET wip_commit = ? WHERE id = ?").run(sha, id);
    return this.getOrThrow(id);
  }

  finish(id: string, input: FinishRun): RunRow {
    this.db
      .prepare(
        `UPDATE runs SET
           status = ?, ended_at = ?, exit_reason = ?, summary = ?, error = ?,
           tokens_in = ?, tokens_out = ?, cost_usd = ?, final_commit = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        nowIso(),
        input.exitReason ?? null,
        input.summary ?? null,
        input.error ?? null,
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        input.costUsd ?? null,
        input.finalCommit ?? null,
        id,
      );
    return this.getOrThrow(id);
  }

  /**
   * Boot-time recovery (RT-07, DESIGN §11.2): interrupted work is surfaced, never
   * silently retried. Returns the affected runs with their stored ACP session.
   */
  markInterrupted(reason = "container restart"): RunRow[] {
    const affected = this.listActive();
    if (affected.length === 0) return [];
    this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = ?, exit_reason = ?
         WHERE status IN ('running','waiting_human')`,
      )
      .run(nowIso(), reason);
    return affected.map((run) => this.getOrThrow(run.id));
  }

  /** History page (OB-05): newest first, optional project filter and cursor. */
  history(opts: { projectId?: string; limit?: number; before?: string } = {}): RunRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId) {
      clauses.push("t.project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.before) {
      clauses.push("r.started_at < ?");
      params.push(opts.before);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
         ${where} ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(...params) as RunRow[];
  }
}
