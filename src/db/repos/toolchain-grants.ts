/**
 * Toolchain authorisations (ST-07, DESIGN §7.6).
 *
 * One row per (project, package manager) the user has authorised to write into that project's
 * durable toolchain directory. Deliberately narrower than the learned allows of PE-10, which are
 * system-wide and keyed by command shape: this is a standing power over a directory that outlives
 * every run, so it is scoped to one project and revocable on its own.
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type ToolchainGrantRow = {
  id: string;
  project_id: string;
  manager: string;
  note: string | null;
  granted_by: string;
  created_at: string;
  uses: number;
  last_used_at: string | null;
};

export class ToolchainGrantsRepo {
  constructor(private readonly db: Db) {}

  /** Idempotent: granting twice is the same grant, not a second one. */
  add(input: {
    projectId: string;
    manager: string;
    note?: string | null;
    grantedBy: string;
  }): ToolchainGrantRow {
    const existing = this.find(input.projectId, input.manager);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO toolchain_grants
           (id, project_id, manager, note, granted_by, created_at, uses)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(ulid(), input.projectId, input.manager, input.note ?? null, input.grantedBy, nowIso());
    return this.find(input.projectId, input.manager)!;
  }

  find(projectId: string, manager: string): ToolchainGrantRow | undefined {
    return this.db
      .prepare("SELECT * FROM toolchain_grants WHERE project_id = ? AND manager = ?")
      .get(projectId, manager) as ToolchainGrantRow | undefined;
  }

  list(projectId?: string): ToolchainGrantRow[] {
    return projectId
      ? (this.db
          .prepare("SELECT * FROM toolchain_grants WHERE project_id = ? ORDER BY manager")
          .all(projectId) as ToolchainGrantRow[])
      : (this.db
          .prepare("SELECT * FROM toolchain_grants ORDER BY project_id, manager")
          .all() as ToolchainGrantRow[]);
  }

  /** The managers a project may use, as a set: what the policy engine consults on an install. */
  managers(projectId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT manager FROM toolchain_grants WHERE project_id = ?")
      .all(projectId) as { manager: string }[];
    return new Set(rows.map((row) => row.manager));
  }

  recordUse(projectId: string, manager: string): void {
    this.db
      .prepare(
        "UPDATE toolchain_grants SET uses = uses + 1, last_used_at = ? WHERE project_id = ? AND manager = ?",
      )
      .run(nowIso(), projectId, manager);
  }

  remove(projectId: string, manager: string): ToolchainGrantRow | undefined {
    const row = this.find(projectId, manager);
    if (!row) return undefined;
    this.db.prepare("DELETE FROM toolchain_grants WHERE id = ?").run(row.id);
    return row;
  }

  /** Every grant of a project, dropped with it (PM-08). */
  removeForProject(projectId: string): number {
    const result = this.db
      .prepare("DELETE FROM toolchain_grants WHERE project_id = ?")
      .run(projectId);
    return result.changes;
  }
}
