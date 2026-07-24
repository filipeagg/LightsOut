-- LightsOut schema, migration version 1 (DESIGN §4, DB-01..04).
-- All timestamps are ISO-8601 UTC strings. All JSON columns are TEXT with a
-- json_valid() CHECK. Pragmas (WAL, foreign_keys, busy_timeout) are set on connect.

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,              -- slug, matches dir name
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,                 -- /workspace/projects/<id>
  repo_remote   TEXT,                          -- nullable: local-only project
  push_policy   TEXT NOT NULL DEFAULT 'manual' CHECK (push_policy IN ('auto','manual','never')),
  policy_pack   TEXT NOT NULL DEFAULT 'default',
  verify_cmd    TEXT,                          -- nullable: no gate (OR-04)
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE chains (
  id          TEXT PRIMARY KEY,                -- ulid
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','paused','completed','aborted')),
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_chains_project ON chains(project_id, created_at);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,                -- ulid
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  project_id  TEXT NOT NULL REFERENCES projects(id),
  position    INTEGER NOT NULL,                -- order within chain (OR-01)
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,                   -- full prompt/acceptance criteria
  agent_id    TEXT NOT NULL,                   -- profile id (AP-01)
  level       TEXT NOT NULL CHECK (level IN ('quick','full')),
  verify_cmd  TEXT,                            -- overrides project verify_cmd
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','ok','doubt','verify_failed',
                                'timeout','stuck','error','aborted','interrupted')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (chain_id, position)
);
CREATE INDEX ix_tasks_project ON tasks(project_id, status);

CREATE TABLE runs (                            -- one task may have several runs (retries, resumes)
  id            TEXT PRIMARY KEY,              -- ulid
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  attempt       INTEGER NOT NULL DEFAULT 1,
  engine        TEXT NOT NULL CHECK (engine IN ('claude','codex')),
  model         TEXT,
  acp_session   TEXT,                          -- adapter session id (SR-05, resume)
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','waiting_human','ok','doubt','verify_failed',
                                  'timeout','stuck','error','aborted','interrupted')),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  exit_reason   TEXT,                          -- human-readable one-liner
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,                          -- NULL when the engine does not report it
  wip_commit    TEXT,
  final_commit  TEXT,
  summary       TEXT,                          -- agent's final summary (plain language)
  error         TEXT,
  UNIQUE (task_id, attempt)
);
CREATE INDEX ix_runs_task ON runs(task_id, started_at);
CREATE INDEX ix_runs_status ON runs(status);

CREATE TABLE events (                          -- append-only; powers panel + history (DB-02, OB-01)
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- also the SSE Last-Event-ID cursor
  run_id    TEXT REFERENCES runs(id),          -- NULL for system-level events
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,                     -- see DESIGN §4.1
  payload   TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX ix_events_run ON events(run_id, id);
CREATE INDEX ix_events_ts  ON events(ts);

CREATE TABLE doubts (
  id             TEXT PRIMARY KEY,             -- ulid
  ref            TEXT NOT NULL,                -- 'D-' || counter per project (human-friendly)
  project_id     TEXT NOT NULL REFERENCES projects(id),
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  run_id         TEXT REFERENCES runs(id),
  kind           TEXT NOT NULL CHECK (kind IN ('functional','permission')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  context        TEXT NOT NULL,
  blocks         TEXT NOT NULL,                -- what it blocks
  options        TEXT NOT NULL CHECK (json_valid(options)),   -- [{id:'A',text:…},…]
  recommendation TEXT,                         -- option id
  second_opinion TEXT CHECK (second_opinion IS NULL OR json_valid(second_opinion)),
  answer         TEXT,                         -- option id or free text
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  UNIQUE (project_id, ref)
);
CREATE INDEX ix_doubts_open ON doubts(status) WHERE status = 'open';

CREATE TABLE decisions (
  id             TEXT PRIMARY KEY,             -- ulid
  project_id     TEXT NOT NULL REFERENCES projects(id),
  task_id        TEXT REFERENCES tasks(id),
  doubt_id       TEXT REFERENCES doubts(id),
  kind           TEXT NOT NULL CHECK (kind IN ('human','provisional','auto')),
  question       TEXT NOT NULL,
  choice         TEXT NOT NULL,
  rationale      TEXT,
  checkpoint_tag TEXT,                         -- git tag when provisional (PE-06, PM-04)
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_decisions_project ON decisions(project_id, created_at);

CREATE TABLE permission_audit (                -- PE-04
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  ts           TEXT NOT NULL,
  action_class TEXT NOT NULL,
  detail       TEXT NOT NULL CHECK (json_valid(detail)),  -- raw ACP request excerpt
  rule_source  TEXT NOT NULL,                  -- 'project'|'agent'|'default'
  verdict      TEXT NOT NULL CHECK (verdict IN ('allow','deny','require_human','provisional')),
  latency_ms   INTEGER NOT NULL
);
CREATE INDEX ix_audit_run ON permission_audit(run_id, id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Aggregations are views over runs, never separate tables (OB-05).

CREATE VIEW v_runs_by_status AS
SELECT t.project_id AS project_id, r.status AS status, COUNT(*) AS runs
FROM runs r JOIN tasks t ON t.id = r.task_id
GROUP BY t.project_id, r.status;

CREATE VIEW v_cost_by_project_day AS
SELECT t.project_id            AS project_id,
       substr(r.started_at, 1, 10) AS day,
       COUNT(*)                AS runs,
       SUM(COALESCE(r.tokens_in, 0))  AS tokens_in,
       SUM(COALESCE(r.tokens_out, 0)) AS tokens_out,
       SUM(r.cost_usd)         AS cost_usd      -- NULL-tolerant: engines may not report
FROM runs r JOIN tasks t ON t.id = r.task_id
GROUP BY t.project_id, day;
