/**
 * Read-only workspace areas per project (PE-09, DESIGN §9.5).
 *
 * An area is the sentence "this project may read this directory of the workspace". It is stored
 * workspace-relative with forward slashes, so the same row means the same thing whichever host
 * wrote it, and it carries who declared it because widening a boundary is a decision.
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type AreaAccess = "read" | "write";

export type ProjectAreaRow = {
  id: string;
  project_id: string;
  /** Workspace-relative, forward slashes, no trailing separator. */
  path: string;
  /** `read` or `write` (PE-09 amended). Defaults to read: the narrower grant. */
  access: AreaAccess;
  note: string | null;
  added_by: string;
  created_at: string;
};

export class AreasRepo {
  constructor(private readonly db: Db) {}

  add(input: {
    projectId: string;
    path: string;
    access?: AreaAccess;
    note?: string | null;
    addedBy: string;
  }): ProjectAreaRow {
    const access: AreaAccess = input.access ?? "read";
    const existing = this.get(input.projectId, input.path);
    if (existing) {
      // Declaring the same path again is how a read area is promoted to a writable one. The
      // reverse narrows it, which is equally a decision someone made; both are recorded by the
      // caller as a config change.
      if (existing.access === access) return existing;
      this.db
        .prepare("UPDATE project_areas SET access = ?, added_by = ? WHERE id = ?")
        .run(access, input.addedBy, existing.id);
      return this.getOrThrow(existing.id);
    }
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO project_areas (id, project_id, path, access, note, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.path, access, input.note ?? null, input.addedBy, nowIso());
    return this.getOrThrow(id);
  }

  get(projectId: string, path: string): ProjectAreaRow | undefined {
    return this.db
      .prepare("SELECT * FROM project_areas WHERE project_id = ? AND path = ?")
      .get(projectId, path) as ProjectAreaRow | undefined;
  }

  getOrThrow(id: string): ProjectAreaRow {
    const row = this.db.prepare("SELECT * FROM project_areas WHERE id = ?").get(id) as
      | ProjectAreaRow
      | undefined;
    if (!row) throw new Error(`area not found: ${id}`);
    return row;
  }

  list(projectId: string): ProjectAreaRow[] {
    return this.db
      .prepare("SELECT * FROM project_areas WHERE project_id = ? ORDER BY path")
      .all(projectId) as ProjectAreaRow[];
  }

  /** Remove by path or by id; returns what was removed, or undefined when there was nothing. */
  remove(projectId: string, pathOrId: string): ProjectAreaRow | undefined {
    const row =
      this.get(projectId, pathOrId) ??
      (this.db.prepare("SELECT * FROM project_areas WHERE id = ? AND project_id = ?").get(
        pathOrId,
        projectId,
      ) as ProjectAreaRow | undefined);
    if (!row) return undefined;
    this.db.prepare("DELETE FROM project_areas WHERE id = ?").run(row.id);
    return row;
  }

  removeForProject(projectId: string): void {
    this.db.prepare("DELETE FROM project_areas WHERE project_id = ?").run(projectId);
  }
}
