/** Vault read audit trail (VT-05): entry ids and field names only, never values. */
import type { Db } from "../db.js";
import type { VaultAuditRow } from "../types.js";
import { nowIso } from "../../ids.js";

export class VaultAuditRepo {
  constructor(private readonly db: Db) {}

  record(runId: string, entryId: string, fields: string[]): void {
    this.db
      .prepare("INSERT INTO vault_audit (run_id, ts, entry_id, fields) VALUES (?, ?, ?, ?)")
      .run(runId, nowIso(), entryId, JSON.stringify(fields));
  }

  /**
   * Entry ids this project's runs have resolved (VT-09).
   *
   * The evidence half of "which credentials does this project need": an entry scoped `*` is
   * offered to everything, so scope alone cannot say what a project depends on, but an entry a
   * run of this project actually read is a dependency and this table has recorded it since VT-05.
   * Ids only, as everywhere in the audit trail.
   */
  entriesForProject(projectId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT va.entry_id AS entry_id
           FROM vault_audit va
           JOIN runs r ON r.id = va.run_id
           JOIN tasks t ON t.id = r.task_id
          WHERE t.project_id = ?
          ORDER BY va.entry_id`,
      )
      .all(projectId) as { entry_id: string }[];
    return rows.map((row) => row.entry_id);
  }

  listForRun(runId: string): VaultAuditRow[] {
    return this.db
      .prepare("SELECT * FROM vault_audit WHERE run_id = ? ORDER BY id")
      .all(runId) as VaultAuditRow[];
  }
}
