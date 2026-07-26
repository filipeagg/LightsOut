/** Projects repository (PM-01, DB-01). */
import { transaction, type Db } from "../db.js";
import type { ProjectRow, PushPolicy } from "../types.js";
import { nowIso } from "../../ids.js";

export type CreateProject = {
  id: string;
  name: string;
  path: string;
  repoRemote?: string | null;
  pushPolicy?: PushPolicy;
  policyPack?: string;
  verifyCmd?: string | null;
  templateId?: string | null;
};

export type UpdateProject = Partial<
  Pick<CreateProject, "name" | "repoRemote" | "pushPolicy" | "policyPack" | "verifyCmd">
> & { archived?: boolean };

export class ProjectsRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateProject): ProjectRow {
    this.db
      .prepare(
        `INSERT INTO projects
           (id, name, path, repo_remote, push_policy, policy_pack, verify_cmd,
            template_id, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.path,
        input.repoRemote ?? null,
        input.pushPolicy ?? "manual",
        input.policyPack ?? "default",
        input.verifyCmd ?? null,
        input.templateId ?? null,
        nowIso(),
      );
    return this.getOrThrow(input.id);
  }

  get(id: string): ProjectRow | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
  }

  getOrThrow(id: string): ProjectRow {
    const row = this.get(id);
    if (!row) throw new Error(`project not found: ${id}`);
    return row;
  }

  list(opts: { includeArchived?: boolean } = {}): ProjectRow[] {
    const sql = opts.includeArchived
      ? "SELECT * FROM projects ORDER BY created_at"
      : "SELECT * FROM projects WHERE archived = 0 ORDER BY created_at";
    return this.db.prepare(sql).all() as ProjectRow[];
  }

  update(id: string, patch: UpdateProject): ProjectRow {
    const columns: Record<keyof UpdateProject, string> = {
      name: "name",
      repoRemote: "repo_remote",
      pushPolicy: "push_policy",
      policyPack: "policy_pack",
      verifyCmd: "verify_cmd",
      archived: "archived",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns) as [
      keyof UpdateProject,
      string,
    ][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(key === "archived" ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return this.getOrThrow(id);
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getOrThrow(id);
  }

  /**
   * Delete the project and everything hanging off it (PM-08).
   *
   * The schema declares the references but no `ON DELETE CASCADE`, and `foreign_keys` is on, so
   * the order below is the cascade written out by hand: children before parents, and within a
   * generation the table that points sideways first (`decisions` before `doubts`,
   * `project_phases` before `tasks`). One transaction, so a failure halfway leaves the project
   * whole rather than half-shredded. System events — the ones with no `run_id` — are kept: they
   * are the record that this project existed and was removed.
   */
  remove(id: string): void {
    const runs = "SELECT id FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)";
    const statements = [
      `DELETE FROM permission_audit WHERE run_id IN (${runs})`,
      `DELETE FROM vault_audit WHERE run_id IN (${runs})`,
      `DELETE FROM events WHERE run_id IN (${runs})`,
      "DELETE FROM decisions WHERE project_id = ?",
      "DELETE FROM doubts WHERE project_id = ?",
      "DELETE FROM project_phases WHERE project_id = ?",
      "DELETE FROM project_knowledge WHERE project_id = ?",
      `DELETE FROM runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
      "DELETE FROM tasks WHERE project_id = ?",
      "DELETE FROM chains WHERE project_id = ?",
      "DELETE FROM projects WHERE id = ?",
    ];
    transaction(this.db, () => {
      for (const sql of statements) this.db.prepare(sql).run(id);
    });
  }
}
