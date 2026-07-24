/** Decisions repository (PE-06, PM-02, DB-01). */
import type { Db } from "../db.js";
import type { DecisionKind, DecisionRow } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export type RecordDecision = {
  projectId: string;
  taskId?: string | null;
  doubtId?: string | null;
  kind: DecisionKind;
  question: string;
  choice: string;
  rationale?: string | null;
  /** Git tag set when the decision is provisional (PE-06, PM-04). */
  checkpointTag?: string | null;
};

export class DecisionsRepo {
  constructor(private readonly db: Db) {}

  record(input: RecordDecision): DecisionRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO decisions
           (id, project_id, task_id, doubt_id, kind, question, choice, rationale,
            checkpoint_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.doubtId ?? null,
        input.kind,
        input.question,
        input.choice,
        input.rationale ?? null,
        input.checkpointTag ?? null,
        nowIso(),
      );
    return this.getOrThrow(id);
  }

  get(id: string): DecisionRow | undefined {
    return this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | DecisionRow
      | undefined;
  }

  getOrThrow(id: string): DecisionRow {
    const row = this.get(id);
    if (!row) throw new Error(`decision not found: ${id}`);
    return row;
  }

  listByProject(projectId: string, limit = 50): DecisionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(projectId, Math.min(Math.max(limit, 1), 500)) as DecisionRow[];
  }

  /** Newest decision of a project: the "last decision" line in docs and panel. */
  latest(projectId: string): DecisionRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as DecisionRow | undefined;
  }

  listByDoubt(doubtId: string): DecisionRow[] {
    return this.db
      .prepare("SELECT * FROM decisions WHERE doubt_id = ? ORDER BY created_at")
      .all(doubtId) as DecisionRow[];
  }
}
