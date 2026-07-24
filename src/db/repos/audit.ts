/** Permission audit repository (PE-04, DB-01): every mediated request, with its verdict. */
import type { Db } from "../db.js";
import type { PermissionAuditRow, PermissionVerdict, RuleSource } from "../types.js";
import { nowIso } from "../../ids.js";

export type RecordAudit = {
  runId: string;
  actionClass: string;
  /** Excerpt of the raw ACP request; stored as JSON, never secrets (NF-02). */
  detail: unknown;
  ruleSource: RuleSource;
  verdict: PermissionVerdict;
  latencyMs: number;
};

export class AuditRepo {
  constructor(private readonly db: Db) {}

  record(input: RecordAudit): PermissionAuditRow {
    const result = this.db
      .prepare(
        `INSERT INTO permission_audit
           (run_id, ts, action_class, detail, rule_source, verdict, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        nowIso(),
        input.actionClass,
        JSON.stringify(input.detail ?? {}),
        input.ruleSource,
        input.verdict,
        Math.round(input.latencyMs),
      );
    return this.getOrThrow(Number(result.lastInsertRowid));
  }

  get(id: number): PermissionAuditRow | undefined {
    return this.db.prepare("SELECT * FROM permission_audit WHERE id = ?").get(id) as
      | PermissionAuditRow
      | undefined;
  }

  getOrThrow(id: number): PermissionAuditRow {
    const row = this.get(id);
    if (!row) throw new Error(`audit row not found: ${id}`);
    return row;
  }

  listByRun(runId: string): PermissionAuditRow[] {
    return this.db
      .prepare("SELECT * FROM permission_audit WHERE run_id = ? ORDER BY id")
      .all(runId) as PermissionAuditRow[];
  }

  countByVerdict(runId: string): Record<PermissionVerdict, number> {
    const rows = this.db
      .prepare(
        "SELECT verdict, COUNT(*) AS n FROM permission_audit WHERE run_id = ? GROUP BY verdict",
      )
      .all(runId) as { verdict: PermissionVerdict; n: number }[];
    const counts: Record<PermissionVerdict, number> = {
      allow: 0,
      deny: 0,
      require_human: 0,
      provisional: 0,
    };
    for (const row of rows) counts[row.verdict] = row.n;
    return counts;
  }
}
