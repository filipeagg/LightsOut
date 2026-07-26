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
  /**
   * Rebuild a table the way SQLite's own ALTER TABLE procedure requires: `foreign_keys` off
   * around the whole transaction, then `foreign_key_check` before it is trusted. The pragma
   * cannot be set from inside a transaction, so it has to be declared here rather than
   * written into the migration's SQL.
   */
  foreignKeys?: "off";
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
 * The doubts CHECK constraint can only grow by rebuilding the table, and a
 * rebuild means dropping a table that `decisions` points at. That is what
 * `foreignKeys: "off"` below is for: SQLite's documented rebuild procedure,
 * with a `foreign_key_check` afterwards so nothing is taken on trust.
 */
const PHASE9_SQL = `
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

/**
 * Version 3: the `hard_rule` doubt kind (KB-11b, §17.4), and `enforcement` on the knowledge
 * attachment so the panel and `project_status` can say which of a project's bases are binding
 * without re-reading every manifest.
 *
 * Same rebuild as version 2, for the same reason: a CHECK constraint can only grow by rebuilding
 * the table, and `decisions` points at `doubts`.
 */
const HARD_RULES_SQL = `
CREATE TABLE doubts_v3 (
  id             TEXT PRIMARY KEY,
  ref            TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  run_id         TEXT REFERENCES runs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('functional','permission','gate','hard_rule')),
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
INSERT INTO doubts_v3 SELECT * FROM doubts;
DROP TABLE doubts;
ALTER TABLE doubts_v3 RENAME TO doubts;
CREATE INDEX ix_doubts_open ON doubts(status) WHERE status = 'open';

ALTER TABLE project_knowledge ADD COLUMN enforcement TEXT NOT NULL DEFAULT 'advisory';
`;

/**
 * Version 4 (PM-09): `projects.context`, the brief every project must carry.
 *
 * Existing rows are backfilled with a factual placeholder marked `status: provisional`: the
 * project's name, its template, and a line saying the brief is pending. It does not block those
 * projects and it does not pretend to be a brief — the panel shows it as provisional until someone
 * writes one. A plain default of '' would have been indistinguishable from a brief someone had
 * chosen to leave empty.
 */
function addProjectContext(db: Db): void {
  db.exec(`ALTER TABLE projects ADD COLUMN context TEXT NOT NULL DEFAULT ''`);
  const rows = db.prepare("SELECT id, name, template_id FROM projects").all() as {
    id: string;
    name: string;
    template_id: string | null;
  }[];
  const update = db.prepare("UPDATE projects SET context = ? WHERE id = ?");
  for (const row of rows) {
    update.run(
      [
        "status: provisional",
        `name: ${row.name}`,
        `template: ${row.template_id ?? "none"}`,
        "note: brief pending; written by migration 4, not by a person (PM-09)",
      ].join("\n"),
      row.id,
    );
  }
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial schema", up: applyInitialSchema },
  {
    version: 2,
    name: "phases, knowledge, vault audit",
    up: PHASE9_SQL,
    foreignKeys: "off",
  },
  {
    version: 3,
    name: "hard rule doubts and knowledge enforcement",
    up: HARD_RULES_SQL,
    foreignKeys: "off",
  },
  { version: 4, name: "project context brief", up: addProjectContext },
];

/** The marker migration 4 writes, and the panel looks for (PM-09). */
export const PROVISIONAL_CONTEXT = "status: provisional";

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

    if (migration.foreignKeys === "off") {
      // The pragma is a no-op inside a transaction, so it goes around it (SQLite's own
      // ALTER TABLE recipe). The check afterwards is what makes turning it off safe.
      db.pragma("foreign_keys = OFF");
      try {
        apply();
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration ${migration.version} left ${violations.length} foreign key violation(s)`,
          );
        }
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      apply();
    }
    applied.push(`${migration.version}:${migration.name}`);
  }

  return { from, to: currentVersion(db), applied };
}
