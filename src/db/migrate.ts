/**
 * Sequential migrations (DB-01).
 * Each migration runs once, inside a transaction, and is recorded in
 * schema_migrations. Version 1 is the full DDL in schema.sql; later phases append
 * entries to MIGRATIONS and never edit an applied one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { nowIso } from "../ids.js";

export type Migration = {
  version: number;
  name: string;
  /** SQL to apply, or a function for migrations that need logic. */
  up: string | ((db: Db) => void);
};

/** Wrap the DDL file so version 1 is an ordinary migration like any other. */
function applyInitialSchema(db: Db): void {
  db.exec(readSchemaSql());
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** schema.sql sits next to the compiled module (copied by the build). */
function readSchemaSql(): string {
  const candidates = [
    path.join(here, "schema.sql"),
    path.join(here, "..", "..", "src", "db", "schema.sql"),
  ];
  for (const file of candidates) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`schema.sql not found (looked in: ${candidates.join(", ")})`);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial schema", up: applyInitialSchema },
];

function currentVersion(db: Db): number {
  const hasTable = db
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get() as { n: number };
  if (hasTable.n !== 1) return 0;
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
    .get() as { v: number };
  return row.v;
}

export type MigrateResult = { from: number; to: number; applied: string[] };

export function migrate(db: Db): MigrateResult {
  const from = currentVersion(db);
  const applied: string[] = [];

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (migration.version <= from) continue;

    const apply = db.transaction(() => {
      if (typeof migration.up === "string") {
        db.exec(migration.up);
      } else {
        migration.up(db);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        nowIso(),
      );
    });
    apply();
    applied.push(`${migration.version}:${migration.name}`);
  }

  return { from, to: currentVersion(db), applied };
}
