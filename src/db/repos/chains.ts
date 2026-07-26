/** Chains repository (OR-01, DB-01). */
import type { Db } from "../db.js";
import type { ChainRow, ChainStatus } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export class ChainsRepo {
  constructor(private readonly db: Db) {}

  create(input: { projectId: string; title: string }): ChainRow {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO chains (id, project_id, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      )
      .run(id, input.projectId, input.title, nowIso());
    return this.getOrThrow(id);
  }

  get(id: string): ChainRow | undefined {
    return this.db.prepare("SELECT * FROM chains WHERE id = ?").get(id) as
      | ChainRow
      | undefined;
  }

  getOrThrow(id: string): ChainRow {
    const row = this.get(id);
    if (!row) throw new Error(`chain not found: ${id}`);
    return row;
  }

  listByProject(projectId: string, opts: { status?: ChainStatus } = {}): ChainRow[] {
    if (opts.status) {
      return this.db
        .prepare(
          "SELECT * FROM chains WHERE project_id = ? AND status = ? ORDER BY created_at DESC",
        )
        .all(projectId, opts.status) as ChainRow[];
    }
    return this.db
      .prepare("SELECT * FROM chains WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as ChainRow[];
  }

  /** The chain currently being executed for a project, if any (one at a time, SR-07). */
  activeForProject(projectId: string): ChainRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM chains WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId) as ChainRow | undefined;
  }

  /**
   * The newest chain of a project whatever its status. `activeForProject` cannot answer for a
   * paused chain, which is exactly the one a resume needs to find.
   */
  latestForProject(projectId: string): ChainRow | undefined {
    return this.db
      .prepare("SELECT * FROM chains WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as ChainRow | undefined;
  }

  setStatus(id: string, status: ChainStatus): ChainRow {
    this.db.prepare("UPDATE chains SET status = ? WHERE id = ?").run(status, id);
    return this.getOrThrow(id);
  }
}
