/** Projects repository (PM-01, DB-01). */
import type { Db } from "../db.js";
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
}
