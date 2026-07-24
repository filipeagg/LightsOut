/**
 * Database handle (DB-01, DB-03, ST-02).
 * Only the orchestrator process opens the database for writing; everything else
 * reads through it. Synchronous better-sqlite3 keeps the single-writer rule trivial.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

export type OpenOptions = {
  /** File path, or ":memory:" for tests. */
  file: string;
  readonly?: boolean;
};

export function openDb({ file, readonly = false }: OpenOptions): Db {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file, { readonly });

  // WAL survives restarts and lets readers work while the writer commits.
  if (!readonly && file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

/**
 * Cheap liveness check for /health (RT-06): the connection answers and the schema
 * is present. Returns a readable error instead of throwing.
 */
export function checkDatabase(db: Db): { ok: boolean; error?: string } {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { n: number };
    if (row.n !== 1) return { ok: false, error: "schema not initialised" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Run fn inside an IMMEDIATE transaction; rolls back on throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped.immediate();
}
