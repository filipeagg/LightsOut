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

  listForRun(runId: string): VaultAuditRow[] {
    return this.db
      .prepare("SELECT * FROM vault_audit WHERE run_id = ? ORDER BY id")
      .all(runId) as VaultAuditRow[];
  }
}
