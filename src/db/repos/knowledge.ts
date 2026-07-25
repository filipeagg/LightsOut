/** Project knowledge attachments (KB-03, KB-05, PM-07). */
import type { Db } from "../db.js";
import type { ProjectKnowledgeRow } from "../types.js";
import { nowIso } from "../../ids.js";

export class ProjectKnowledgeRepo {
  constructor(private readonly db: Db) {}

  attach(input: {
    projectId: string;
    baseId: string;
    kind: string;
    writable?: boolean;
  }): ProjectKnowledgeRow {
    this.db
      .prepare(
        `INSERT INTO project_knowledge (project_id, base_id, kind, writable, attached_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, base_id)
         DO UPDATE SET kind = excluded.kind, writable = excluded.writable`,
      )
      .run(
        input.projectId,
        input.baseId,
        input.kind,
        input.writable ? 1 : 0,
        nowIso(),
      );
    return this.get(input.projectId, input.baseId)!;
  }

  detach(projectId: string, baseId: string): boolean {
    const info = this.db
      .prepare("DELETE FROM project_knowledge WHERE project_id = ? AND base_id = ?")
      .run(projectId, baseId);
    return info.changes > 0;
  }

  get(projectId: string, baseId: string): ProjectKnowledgeRow | undefined {
    return this.db
      .prepare("SELECT * FROM project_knowledge WHERE project_id = ? AND base_id = ?")
      .get(projectId, baseId) as ProjectKnowledgeRow | undefined;
  }

  list(projectId: string): ProjectKnowledgeRow[] {
    return this.db
      .prepare("SELECT * FROM project_knowledge WHERE project_id = ? ORDER BY base_id")
      .all(projectId) as ProjectKnowledgeRow[];
  }

  /** The single base a curation project may write into, if any (KB-05). */
  writableBase(projectId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT base_id FROM project_knowledge WHERE project_id = ? AND writable = 1 LIMIT 1",
      )
      .get(projectId) as { base_id: string } | undefined;
    return row?.base_id;
  }
}
