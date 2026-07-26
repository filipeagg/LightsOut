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

/**
 * Version 5 (PE-09): the directories of the workspace a project may read, outside its own.
 * Declared per project, unique per path, and recorded with who declared them — a widened boundary
 * is a decision, not a setting.
 */
const PROJECT_AREAS_SQL = `
CREATE TABLE project_areas (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path       TEXT NOT NULL,
  note       TEXT,
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, path)
);
CREATE INDEX ix_project_areas ON project_areas(project_id);
`;

/**
 * Version 6 (PE-10): what a human has already allowed, remembered by the *shape* of the command.
 *
 * A permission gate for an unmatched command (`other`) that a person answers with "allow" is a
 * lesson, not an event: the same shape asking again eleven minutes later is the system wasting
 * their time. `doubts` gains the class and the shape so the answer knows what it is teaching.
 */
const LEARNED_ALLOWS_SQL = `
CREATE TABLE learned_allows (
  id           TEXT PRIMARY KEY,
  shape        TEXT NOT NULL UNIQUE,
  sample       TEXT NOT NULL,
  action_class TEXT NOT NULL,
  learned_from TEXT,
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

ALTER TABLE doubts ADD COLUMN action_class TEXT;
ALTER TABLE doubts ADD COLUMN action_shape TEXT;
`;

/**
 * Version 7 (PE-12): what a task said it needs, and what was granted for its run.
 * Both are JSON arrays of capability names, kept on the task so a rerun keeps them and the panel
 * can show why a run had powers its agent's pack does not.
 */
const TASK_CAPABILITIES_SQL = `
ALTER TABLE tasks ADD COLUMN needs TEXT;
ALTER TABLE tasks ADD COLUMN grants TEXT;
`;

/**
 * Version 8 (AP-09): the engine, model and reasoning level chosen for this launch.
 *
 * All three are nullable and NULL means "use the profile's". Nullable rather than backfilled from
 * the agent on purpose: a task written before this migration must keep following its profile when
 * the profile changes, and a copied value would silently freeze it.
 */
const TASK_MODEL_OVERRIDE_SQL = `
ALTER TABLE tasks ADD COLUMN engine TEXT;
ALTER TABLE tasks ADD COLUMN model TEXT;
ALTER TABLE tasks ADD COLUMN reasoning TEXT;
`;

/**
 * Version 9 (ST-07, ST-08): the durable toolchain.
 *
 * `toolchain_grants` records which package managers the user has authorised for a project — per
 * project and per manager, deliberately not the system-wide learned shapes of PE-10: a shape is
 * one command, and this is a standing power over a directory that outlives every run. Allowing
 * npm for a web project is not allowing it everywhere, and the row records who said so.
 *
 * The `toolchain` doubt kind (ST-08) is what asks for a system package, which needs root and a
 * rebuild the user runs themselves. Like `hard_rule` it never sees the advisor and never
 * auto-continues, so the CHECK has to grow — and a CHECK only grows by rebuilding the table, with
 * `decisions` pointing at it. Same recipe as versions 2 and 3.
 */
const TOOLCHAIN_SQL = `
CREATE TABLE doubts_v4 (
  id             TEXT PRIMARY KEY,
  ref            TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  run_id         TEXT REFERENCES runs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('functional','permission','gate','hard_rule','toolchain')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  context        TEXT NOT NULL,
  blocks         TEXT NOT NULL,
  options        TEXT NOT NULL CHECK (json_valid(options)),
  recommendation TEXT,
  second_opinion TEXT CHECK (second_opinion IS NULL OR json_valid(second_opinion)),
  answer         TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  action_class   TEXT,
  action_shape   TEXT,
  UNIQUE (project_id, ref)
);
INSERT INTO doubts_v4 SELECT
  id, ref, project_id, task_id, run_id, kind, status, context, blocks, options,
  recommendation, second_opinion, answer, created_at, answered_at, action_class, action_shape
FROM doubts;
DROP TABLE doubts;
ALTER TABLE doubts_v4 RENAME TO doubts;
CREATE INDEX ix_doubts_open ON doubts(status) WHERE status = 'open';

CREATE TABLE toolchain_grants (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  manager      TEXT NOT NULL,
  note         TEXT,
  granted_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  UNIQUE (project_id, manager)
);
CREATE INDEX ix_toolchain_grants ON toolchain_grants(project_id);
`;

/**
 * Version 10 (PV-01..03): preview servers.
 *
 * A table rather than an in-memory map, so the panel and MCP read one truth and a preview left
 * behind by a crash is visible rather than merely leaked. The rows are memory of processes the
 * container owns, so the boot recovery pass clears them: a restart killed every one of them.
 */
const PREVIEWS_SQL = `
CREATE TABLE previews (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  port          INTEGER NOT NULL,
  command       TEXT NOT NULL,
  normalised    TEXT,
  cwd           TEXT NOT NULL,
  pid           INTEGER,
  log_path      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','stopped','exited','expired')),
  started_by    TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  expires_at    TEXT,
  ended_at      TEXT,
  exit_reason   TEXT
);
CREATE INDEX ix_previews_project ON previews(project_id, status);
CREATE UNIQUE INDEX ix_previews_port_live ON previews(port) WHERE status = 'running';
`;

/**
 * Version 11 (OR-12, §7.7): a project declares whether its runs must finish without a person.
 *
 * Default 1 — on. Unattended execution is what the system is for, and the four incidents recorded
 * in STATE.md are all the same story: a run that stopped, and nobody knew. A project that wants a
 * person in the loop says so; the burden of the flag belongs on the exception.
 */
const UNATTENDED_SQL = `
ALTER TABLE projects ADD COLUMN unattended INTEGER NOT NULL DEFAULT 1;
`;

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
  { version: 5, name: "project read-only areas", up: PROJECT_AREAS_SQL },
  { version: 6, name: "learned allows", up: LEARNED_ALLOWS_SQL },
  { version: 7, name: "task capabilities", up: TASK_CAPABILITIES_SQL },
  { version: 8, name: "task engine and model override", up: TASK_MODEL_OVERRIDE_SQL },
  {
    version: 9,
    name: "toolchain grants and the toolchain doubt kind",
    up: TOOLCHAIN_SQL,
    foreignKeys: "off",
  },
  { version: 10, name: "preview servers", up: PREVIEWS_SQL },
  { version: 11, name: "unattended projects", up: UNATTENDED_SQL },
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
