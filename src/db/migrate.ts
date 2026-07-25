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

/**
 * Version 2 (phase 9): phases, knowledge attachments and the vault audit trail
 * (TP-05/06, KB-03, VT-05), plus projects.template_id (PM-07) and the 'gate'
 * doubt kind (TP-01, §16.2).
 *
 * The doubts CHECK constraint can only grow by rebuilding the table. Enforcement
 * of decisions.doubt_id is deferred to commit, by which point the rebuilt table
 * carries the same ids under the same name.
 */
const PHASE9_SQL = `
PRAGMA defer_foreign_keys = ON;

ALTER TABLE projects ADD COLUMN template_id TEXT;

CREATE TABLE doubts_v2 (
  id             TEXT PRIMARY KEY,
  ref            TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  run_id         TEXT REFERENCES runs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('functional','permission','gate')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  context        TEXT NOT NULL,
  blocks         TEXT NOT NULL,
  options        TEXT NOT NULL CHECK (json_valid(options)),
  recommendation TEXT,
  second_opinion TEXT CHECK (second_opinion IS NULL OR json_valid(second_opinion)),
  answer         TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  UNIQUE (project_id, ref)
);
INSERT INTO doubts_v2 SELECT * FROM doubts;
DROP TABLE doubts;
ALTER TABLE doubts_v2 RENAME TO doubts;
CREATE INDEX ix_doubts_open ON doubts(status) WHERE status = 'open';

CREATE TABLE project_phases (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  position      INTEGER NOT NULL,
  phase_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  deliverable   TEXT,
  verify_cmd    TEXT,
  gate          TEXT NOT NULL DEFAULT 'auto' CHECK (gate IN ('auto','human')),
  optional      INTEGER NOT NULL DEFAULT 0,
  repeatable    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed','skipped')),
  task_id       TEXT REFERENCES tasks(id),
  started_at    TEXT,
  ended_at      TEXT,
  UNIQUE (project_id, position),
  UNIQUE (project_id, phase_id)
);
CREATE INDEX ix_phases_project ON project_phases(project_id, position);

CREATE TABLE project_knowledge (
  project_id    TEXT NOT NULL REFERENCES projects(id),
  base_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  writable      INTEGER NOT NULL DEFAULT 0,
  attached_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, base_id)
);

CREATE TABLE vault_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  ts         TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  fields     TEXT NOT NULL CHECK (json_valid(fields))
);
CREATE INDEX ix_vault_audit_run ON vault_audit(run_id, id);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial schema", up: applyInitialSchema },
  { version: 2, name: "phases, knowledge, vault audit", up: PHASE9_SQL },
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
