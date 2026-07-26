/**
 * Learned allows (PE-10, DESIGN §7.4).
 *
 * One row per command shape a person has already allowed at a permission gate. Read on every
 * unmatched command, so it is kept small and simple: a unique shape, the sample it came from, and
 * a use counter that makes an unused rule easy to spot and revoke.
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type LearnedAllowRow = {
  id: string;
  shape: string;
  sample: string;
  action_class: string;
  learned_from: string | null;
  added_by: string;
  created_at: string;
  uses: number;
  last_used_at: string | null;
};

export class LearnedRepo {
  constructor(private readonly db: Db) {}

  add(input: {
    shape: string;
    sample: string;
    actionClass: string;
    learnedFrom?: string | null;
    addedBy: string;
  }): LearnedAllowRow {
    const existing = this.byShape(input.shape);
    if (existing) return existing;
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO learned_allows
           (id, shape, sample, action_class, learned_from, added_by, created_at, uses)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        input.shape,
        input.sample,
        input.actionClass,
        input.learnedFrom ?? null,
        input.addedBy,
        nowIso(),
      );
    return this.byShape(input.shape)!;
  }

  byShape(shape: string): LearnedAllowRow | undefined {
    return this.db.prepare("SELECT * FROM learned_allows WHERE shape = ?").get(shape) as
      | LearnedAllowRow
      | undefined;
  }

  list(): LearnedAllowRow[] {
    return this.db
      .prepare("SELECT * FROM learned_allows ORDER BY uses DESC, created_at DESC")
      .all() as LearnedAllowRow[];
  }

  /** Every shape, as a set: what the policy engine consults on an unmatched command. */
  shapes(): Set<string> {
    const rows = this.db.prepare("SELECT shape FROM learned_allows").all() as { shape: string }[];
    return new Set(rows.map((row) => row.shape));
  }

  recordUse(shape: string): void {
    this.db
      .prepare("UPDATE learned_allows SET uses = uses + 1, last_used_at = ? WHERE shape = ?")
      .run(nowIso(), shape);
  }

  remove(shapeOrId: string): LearnedAllowRow | undefined {
    const row =
      this.byShape(shapeOrId) ??
      (this.db.prepare("SELECT * FROM learned_allows WHERE id = ?").get(shapeOrId) as
        | LearnedAllowRow
        | undefined);
    if (!row) return undefined;
    this.db.prepare("DELETE FROM learned_allows WHERE id = ?").run(row.id);
    return row;
  }
}
