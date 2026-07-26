/** Tasks repository (OR-01..03, DB-01). */
import type { Db } from "../db.js";
import type { TaskLevel, TaskRow, TaskStatus } from "../types.js";
import { nowIso, ulid } from "../../ids.js";

export type CreateTask = {
  chainId: string;
  projectId: string;
  title: string;
  spec: string;
  agentId: string;
  level?: TaskLevel;
  verifyCmd?: string | null;
  /** Explicit position; appended after the last one when omitted. */
  position?: number;
  /** What the launch said this task needs, and what was granted for it (PE-12). */
  needs?: string[];
  grants?: string[];
  /**
   * The engine, model and reasoning level chosen for this launch (AP-09). Undefined or null means
   * "whatever the agent profile says", resolved at run time so a profile edit still reaches it.
   */
  engine?: string | null;
  model?: string | null;
  reasoning?: string | null;
};

export class TasksRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateTask): TaskRow {
    const id = ulid();
    const ts = nowIso();
    const position = input.position ?? this.nextPosition(input.chainId);
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, chain_id, project_id, position, title, spec, agent_id, level, verify_cmd,
            status, created_at, updated_at, needs, grants, engine, model, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.chainId,
        input.projectId,
        position,
        input.title,
        input.spec,
        input.agentId,
        input.level ?? "full",
        input.verifyCmd ?? null,
        ts,
        ts,
        input.needs?.length ? JSON.stringify(input.needs) : null,
        input.grants?.length ? JSON.stringify(input.grants) : null,
        input.engine ?? null,
        input.model ?? null,
        input.reasoning ?? null,
      );
    return this.getOrThrow(id);
  }

  /** Insert a whole chain's tasks in one transaction, preserving order (OR-01). */
  createMany(inputs: CreateTask[]): TaskRow[] {
    const insert = this.db.transaction((rows: CreateTask[]) =>
      rows.map((row) => this.create(row)),
    );
    return insert(inputs);
  }

  nextPosition(chainId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM tasks WHERE chain_id = ?")
      .get(chainId) as { p: number };
    return row.p + 1;
  }

  get(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
  }

  getOrThrow(id: string): TaskRow {
    const row = this.get(id);
    if (!row) throw new Error(`task not found: ${id}`);
    return row;
  }

  listByChain(chainId: string): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE chain_id = ? ORDER BY position")
      .all(chainId) as TaskRow[];
  }

  /** Next queued task of a chain, in order: the chain loop's primitive (OR-02). */
  nextQueued(chainId: string): TaskRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE chain_id = ? AND status = 'queued' ORDER BY position LIMIT 1",
      )
      .get(chainId) as TaskRow | undefined;
  }

  listByStatus(status: TaskStatus): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at")
      .all(status) as TaskRow[];
  }

  setStatus(id: string, status: TaskStatus): TaskRow {
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
    return this.getOrThrow(id);
  }
}
