/**
 * Notes left for a run that is already going (SR-09, DESIGN §6.8).
 *
 * The point of the table is `delivered_at`. A run may not finish with a note nobody read, and the
 * only way to know that without trusting the agent is to ask the database which notes are still
 * pending for this run — once, at the end of every turn.
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type RunNoteRow = {
  id: string;
  run_id: string;
  project_id: string;
  note: string;
  created_by: string;
  created_at: string;
  delivered_at: string | null;
  /** How it got there: read from the inbox file, or handed over in a steering turn. */
  delivery: "inbox" | "turn" | null;
};

export class RunNotesRepo {
  constructor(private readonly db: Db) {}

  add(input: { runId: string; projectId: string; note: string; createdBy: string }): RunNoteRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO run_notes (id, run_id, project_id, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.runId, input.projectId, input.note.trim(), input.createdBy, nowIso());
    return this.getOrThrow(id);
  }

  get(id: string): RunNoteRow | undefined {
    return this.db.prepare("SELECT * FROM run_notes WHERE id = ?").get(id) as RunNoteRow | undefined;
  }

  getOrThrow(id: string): RunNoteRow {
    const row = this.get(id);
    if (!row) throw new Error(`run note not found: ${id}`);
    return row;
  }

  /** Everything left for this run, oldest first: order is meaning when two notes disagree. */
  pending(runId: string): RunNoteRow[] {
    return this.db
      .prepare("SELECT * FROM run_notes WHERE run_id = ? AND delivered_at IS NULL ORDER BY created_at")
      .all(runId) as RunNoteRow[];
  }

  list(runId: string): RunNoteRow[] {
    return this.db
      .prepare("SELECT * FROM run_notes WHERE run_id = ? ORDER BY created_at")
      .all(runId) as RunNoteRow[];
  }

  /**
   * Take everything pending and mark it delivered in one transaction, so two callers — the file
   * the agent reads and the steering turn the runner sends — cannot deliver the same note twice.
   */
  takePending(runId: string, delivery: "inbox" | "turn"): RunNoteRow[] {
    return this.db.transaction(() => {
      const rows = this.pending(runId);
      if (rows.length === 0) return rows;
      const mark = this.db.prepare(
        "UPDATE run_notes SET delivered_at = ?, delivery = ? WHERE id = ?",
      );
      const at = nowIso();
      for (const row of rows) mark.run(at, delivery, row.id);
      return rows;
    })();
  }

  countPending(runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM run_notes WHERE run_id = ? AND delivered_at IS NULL")
      .get(runId) as { n: number };
    return row.n;
  }
}
