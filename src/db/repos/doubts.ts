/**
 * Doubts repository (DO-01..05, DB-01).
 * `id` is a ulid; `ref` is the human-friendly label ("D-3") numbered per project
 * and unique within it. Everything user-facing shows `ref`.
 */
import type { Db } from "../db.js";
import type { DoubtKind, DoubtOption, DoubtRow, DoubtStatus } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export type OpenDoubt = {
  projectId: string;
  taskId: string;
  runId?: string | null;
  kind: DoubtKind;
  context: string;
  blocks: string;
  options: DoubtOption[];
  recommendation?: string | null;
};

export type SecondOpinion = {
  engine: string;
  agrees: boolean;
  confidence: number;
  reasoning?: string;
};

export class DoubtsRepo {
  constructor(private readonly db: Db) {}

  /** Allocate the next per-project ref and insert, atomically. */
  open(input: OpenDoubt): DoubtRow {
    const insert = this.db.transaction((): string => {
      const id = ulid();
      const ref = this.nextRef(input.projectId);
      this.db
        .prepare(
          `INSERT INTO doubts
             (id, ref, project_id, task_id, run_id, kind, status, context, blocks,
              options, recommendation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ref,
          input.projectId,
          input.taskId,
          input.runId ?? null,
          input.kind,
          input.context,
          input.blocks,
          JSON.stringify(input.options),
          input.recommendation ?? null,
          nowIso(),
        );
      return id;
    });
    return this.getOrThrow(insert());
  }

  nextRef(projectId: string): string {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(CAST(substr(ref, 3) AS INTEGER)), 0) AS n
         FROM doubts WHERE project_id = ? AND ref LIKE 'D-%'`,
      )
      .get(projectId) as { n: number };
    return `D-${row.n + 1}`;
  }

  get(id: string): DoubtRow | undefined {
    return this.db.prepare("SELECT * FROM doubts WHERE id = ?").get(id) as
      | DoubtRow
      | undefined;
  }

  getOrThrow(id: string): DoubtRow {
    const row = this.get(id);
    if (!row) throw new Error(`doubt not found: ${id}`);
    return row;
  }

  getByRef(projectId: string, ref: string): DoubtRow | undefined {
    return this.db
      .prepare("SELECT * FROM doubts WHERE project_id = ? AND ref = ?")
      .get(projectId, ref) as DoubtRow | undefined;
  }

  /** Resolve either a ulid or a human ref; projectId is required for refs. */
  resolve(idOrRef: string, projectId?: string): DoubtRow | undefined {
    const byId = this.get(idOrRef);
    if (byId) return byId;
    if (projectId) return this.getByRef(projectId, idOrRef);
    const matches = this.db
      .prepare("SELECT * FROM doubts WHERE ref = ?")
      .all(idOrRef) as DoubtRow[];
    return matches.length === 1 ? matches[0] : undefined;
  }

  list(opts: { projectId?: string; status?: DoubtStatus } = {}): DoubtRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM doubts ${where} ORDER BY created_at`)
      .all(...params) as DoubtRow[];
  }

  listOpen(projectId?: string): DoubtRow[] {
    return projectId
      ? this.list({ projectId, status: "open" })
      : this.list({ status: "open" });
  }

  setSecondOpinion(id: string, opinion: SecondOpinion): DoubtRow {
    this.db
      .prepare("UPDATE doubts SET second_opinion = ? WHERE id = ?")
      .run(JSON.stringify(opinion), id);
    return this.getOrThrow(id);
  }

  answer(id: string, answer: string): DoubtRow {
    this.db
      .prepare(
        "UPDATE doubts SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?",
      )
      .run(answer, nowIso(), id);
    return this.getOrThrow(id);
  }

  close(id: string): DoubtRow {
    this.db.prepare("UPDATE doubts SET status = 'closed' WHERE id = ?").run(id);
    return this.getOrThrow(id);
  }

  /** Parsed options, for callers that render them as choices (MC-03). */
  options(row: DoubtRow): DoubtOption[] {
    return JSON.parse(row.options) as DoubtOption[];
  }

  secondOpinion(row: DoubtRow): SecondOpinion | null {
    return row.second_opinion ? (JSON.parse(row.second_opinion) as SecondOpinion) : null;
  }
}
