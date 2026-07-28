/**
 * Triggers: launches with a clock on them (TR-01..07, DESIGN §16b).
 */
import type { Db } from "../db.js";
import { nowIso, ulid } from "../../ids.js";

export type TriggerRow = {
  id: string;
  project_id: string;
  name: string;
  cron: string;
  /** The repeatable phase this fires (TR-02), or null when it fires a free task. */
  phase_ref: string | null;
  /** The agent of the free task, or null when it fires a phase. */
  agent_id: string | null;
  title: string | null;
  request: string;
  expects: string;
  enabled: number;
  created_by: string;
  created_at: string;
  last_fired_at: string | null;
  /** What happened last time, in one line: the launch, or the reason there was none (TR-05). */
  last_result: string | null;
};

export type CreateTrigger = {
  projectId: string;
  name: string;
  cron: string;
  phaseRef?: string | null;
  agentId?: string | null;
  title?: string | null;
  request: string;
  expects: string;
  enabled?: boolean;
  createdBy: string;
};

/**
 * Everything about a trigger is editable, including which project and which phase (TR-09 amended).
 * `phaseRef` and `agentId` are nullable on purpose: switching from a phase to a free task sets one
 * and clears the other in the same statement, which is what the table's CHECK requires.
 */
export type UpdateTrigger = Partial<Omit<CreateTrigger, "createdBy">>;

export class TriggersRepo {
  constructor(private readonly db: Db) {}

  create(input: CreateTrigger): TriggerRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, project_id, name, cron, phase_ref, agent_id, title, request, expects,
            enabled, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.name,
        input.cron,
        input.phaseRef ?? null,
        input.agentId ?? null,
        input.title ?? null,
        input.request,
        input.expects,
        input.enabled === false ? 0 : 1,
        input.createdBy,
        nowIso(),
      );
    return this.getOrThrow(id);
  }

  get(id: string): TriggerRow | undefined {
    return this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as TriggerRow | undefined;
  }

  getOrThrow(id: string): TriggerRow {
    const row = this.get(id);
    if (!row) throw new Error(`trigger not found: ${id}`);
    return row;
  }

  list(projectId?: string): TriggerRow[] {
    return (
      projectId
        ? this.db
            .prepare("SELECT * FROM triggers WHERE project_id = ? ORDER BY created_at")
            .all(projectId)
        : this.db.prepare("SELECT * FROM triggers ORDER BY created_at").all()
    ) as TriggerRow[];
  }

  /** Only these are considered by the scheduler; a disabled trigger is kept, not run (TR-01). */
  listEnabled(): TriggerRow[] {
    return this.db
      .prepare("SELECT * FROM triggers WHERE enabled = 1 ORDER BY created_at")
      .all() as TriggerRow[];
  }

  update(id: string, patch: UpdateTrigger): TriggerRow {
    const columns: Record<keyof UpdateTrigger, string> = {
      projectId: "project_id",
      name: "name",
      cron: "cron",
      phaseRef: "phase_ref",
      agentId: "agent_id",
      title: "title",
      request: "request",
      expects: "expects",
      enabled: "enabled",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns) as [keyof UpdateTrigger, string][]) {
      const value = patch[key];
      // `null` is a value here — it is how a target is cleared — so only `undefined` is skipped.
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.getOrThrow(id);
  }

  /** What happened at this firing, whether it launched or was skipped (TR-05). */
  recordFiring(id: string, at: Date, result: string): void {
    this.db
      .prepare("UPDATE triggers SET last_fired_at = ?, last_result = ? WHERE id = ?")
      .run(at.toISOString(), result.slice(0, 300), id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id).changes > 0;
  }

  removeForProject(projectId: string): number {
    return this.db.prepare("DELETE FROM triggers WHERE project_id = ?").run(projectId).changes;
  }
}
