/** Project phases repository (TP-05..08, DESIGN §16.2). */
import type { Db } from "../db.js";
import type { PhaseGate, PhaseStatus, ProjectPhaseRow } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export type CreatePhase = {
  projectId: string;
  position: number;
  phaseId: string;
  title: string;
  agentId: string;
  instructions: string;
  deliverable?: string | null;
  verifyCmd?: string | null;
  gate?: PhaseGate;
  optional?: boolean;
  repeatable?: boolean;
};

export class PhasesRepo {
  constructor(private readonly db: Db) {}

  create(input: CreatePhase): ProjectPhaseRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO project_phases
           (id, project_id, position, phase_id, title, agent_id, instructions,
            deliverable, verify_cmd, gate, optional, repeatable, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        input.projectId,
        input.position,
        input.phaseId,
        input.title,
        input.agentId,
        input.instructions,
        input.deliverable ?? null,
        input.verifyCmd ?? null,
        input.gate ?? "auto",
        input.optional ? 1 : 0,
        input.repeatable ? 1 : 0,
      );
    return this.getOrThrow(id);
  }

  /**
   * Insert an ad-hoc phase at a position, shifting the rest down (TP-08).
   * SQLite checks UNIQUE (project_id, position) per row, so a plain ascending
   * `position + 1` collides on the first row. `UPDATE … ORDER BY` (the design's
   * original wording) needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which the bundled
   * better-sqlite3 build does not carry. Parking the shifted rows on negative
   * positions and flipping them back needs no compile option and cannot collide,
   * because no real position is ever negative.
   */
  insertAt(input: CreatePhase): ProjectPhaseRow {
    const insert = this.db.transaction((): ProjectPhaseRow => {
      this.db
        .prepare(
          `UPDATE project_phases SET position = -(position + 1)
             WHERE project_id = ? AND position >= ?`,
        )
        .run(input.projectId, input.position);
      this.db
        .prepare(
          "UPDATE project_phases SET position = -position WHERE project_id = ? AND position < 0",
        )
        .run(input.projectId);
      return this.create(input);
    });
    return insert();
  }

  get(id: string): ProjectPhaseRow | undefined {
    return this.db.prepare("SELECT * FROM project_phases WHERE id = ?").get(id) as
      | ProjectPhaseRow
      | undefined;
  }

  getOrThrow(id: string): ProjectPhaseRow {
    const row = this.get(id);
    if (!row) throw new Error(`phase not found: ${id}`);
    return row;
  }

  /** Resolve by the template-level phase id humans read (TP-06). */
  getByRef(projectId: string, phaseRef: string): ProjectPhaseRow | undefined {
    return this.db
      .prepare("SELECT * FROM project_phases WHERE project_id = ? AND phase_id = ?")
      .get(projectId, phaseRef) as ProjectPhaseRow | undefined;
  }

  getByTask(taskId: string): ProjectPhaseRow | undefined {
    return this.db.prepare("SELECT * FROM project_phases WHERE task_id = ?").get(taskId) as
      | ProjectPhaseRow
      | undefined;
  }

  list(projectId: string): ProjectPhaseRow[] {
    return this.db
      .prepare("SELECT * FROM project_phases WHERE project_id = ? ORDER BY position")
      .all(projectId) as ProjectPhaseRow[];
  }

  /** The next phase that has never run, in position order. */
  nextPending(projectId: string): ProjectPhaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM project_phases
           WHERE project_id = ? AND status = 'pending'
           ORDER BY position LIMIT 1`,
      )
      .get(projectId) as ProjectPhaseRow | undefined;
  }

  running(projectId: string): ProjectPhaseRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM project_phases
           WHERE project_id = ? AND status = 'running'
           ORDER BY position LIMIT 1`,
      )
      .get(projectId) as ProjectPhaseRow | undefined;
  }

  maxPosition(projectId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) AS p FROM project_phases WHERE project_id = ?",
      )
      .get(projectId) as { p: number };
    return row.p;
  }

  /** How many ad-hoc phases exist, so the next one can be named adhoc-<n> (TP-08). */
  adhocCount(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM project_phases
           WHERE project_id = ? AND phase_id LIKE 'adhoc-%'`,
      )
      .get(projectId) as { n: number };
    return row.n;
  }

  markRunning(id: string, taskId: string): ProjectPhaseRow {
    this.db
      .prepare(
        `UPDATE project_phases
           SET status = 'running', task_id = ?, started_at = ?, ended_at = NULL
           WHERE id = ?`,
      )
      .run(taskId, nowIso(), id);
    return this.getOrThrow(id);
  }

  setStatus(id: string, status: PhaseStatus): ProjectPhaseRow {
    const ended = status === "running" || status === "pending" ? null : nowIso();
    this.db
      .prepare("UPDATE project_phases SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, ended, id);
    return this.getOrThrow(id);
  }
}
