# LightsOut — Technical Design

Status: draft for review
Companion to: REQUIREMENTS.md (requirement IDs referenced throughout)
Stack: TypeScript / Node.js 22, single process, SQLite (WAL), ACP, MCP. See REQUIREMENTS.md ST-01..ST-06.

---

## 1. Architecture overview

One container, one Node.js process, four internal subsystems sharing an in-process event bus:

```
┌────────────────────────── container: lightsout ──────────────────────────┐
│                                                                           │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌───────────┐  │
│  │ MCP server   │   │ Orchestrator │   │ ACP runner    │   │ HTTP      │  │
│  │ (stdio bridge│──▶│ chains, locks│──▶│ sessions,     │   │ panel,SSE │  │
│  │  + /mcp HTTP)│   │ doubts, git  │   │ policy engine │   │ /health   │  │
│  └─────────────┘   └──────┬───────┘   └──────┬────────┘   └─────▲─────┘  │
│                            │                  │                  │        │
│                            ▼                  ▼                  │        │
│                    ┌──────────────────────────────────┐   event bus      │
│                    │        SQLite (/data, WAL)       │──────────┘        │
│                    └──────────────────────────────────┘                   │
│                                                                           │
│  /workspace (host folder, RT-02)         /home/app/.claude  .codex (vols)│
│    ├── agents/    (profile + policy overrides)                            │
│    ├── templates/ (project template overrides)                            │
│    ├── knowledge/ (curated bases)                                         │
│    ├── vault.yaml (git-ignored)                                           │
│    └── projects/  (one dir per project, own git repo)                      │
│                                                                           │
│  /builtin (in the image, read-only: agents, policies, templates)          │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ MCP (Claude Desktop)                    ▲ browser (control + views)
```

Both arrows are control surfaces (WP-02, MC-01) and both enter through the same functions
(§12.0). The browser is not a viewer with a few buttons; it is the second front end.

Data-flow rule (OB-01): every fact shown anywhere (panel, MCP responses, history) is read from SQLite. The bus only carries "something changed" signals so the SSE layer can push fresh reads; it is never a data source of record.

Single-writer rule (DB-03, ST-02): only the orchestrator process opens the database for writing. The MCP stdio bridge is a separate OS process but holds no state and no DB handle; it proxies JSON-RPC to the main process over HTTP (see §10.1).

## 2. Repository structure

```
lightsout/
├── README.md
├── REQUIREMENTS.md
├── DESIGN.md                     # this file
├── LICENSE                       # Apache-2.0 (NF-04)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # boot: config → db → recovery → subsystems
│   ├── config.ts                 # env parsing + defaults (zod)
│   ├── bus.ts                    # typed EventEmitter (in-process)
│   ├── db/
│   │   ├── schema.sql            # full DDL (§4)
│   │   ├── migrate.ts            # sequential migrations, schema_migrations
│   │   └── repos/                # one typed repo per domain (projects.ts, tasks.ts, runs.ts, events.ts, doubts.ts, decisions.ts, audit.ts)
│   ├── agents/
│   │   ├── loader.ts             # load + watch agents/*.yaml, layered over builtin/ (AP-01..03, BA-01)
│   │   ├── writer.ts             # panel-driven profile create/edit → YAML (AP-06..08)
│   │   ├── models.ts             # accepted model + reasoning values per engine (AP-08)
│   │   └── schema.ts             # zod schema for profiles
│   ├── templates/
│   │   ├── loader.ts             # load + watch templates/*.yaml, layered over builtin/ (TP-01..04)
│   │   ├── writer.ts             # panel-driven template create/clone/edit (TP-04)
│   │   └── schema.ts             # zod schema for templates and phases
│   ├── knowledge/
│   │   ├── loader.ts             # scan knowledge/*/knowledge.yaml manifests (KB-01..02)
│   │   ├── inject.ts             # build the context block, budget and relevance (KB-04, KB-06)
│   │   └── schema.ts             # zod schema for manifests
│   ├── vault/
│   │   ├── vault.ts              # read/write the git-ignored vault file, scope filter (VT-01..03)
│   │   └── schema.ts             # zod schema for entries
│   ├── policy/
│   │   ├── engine.ts             # evaluate() (§7)
│   │   ├── classify.ts           # ACP request → action class
│   │   └── schema.ts             # zod schema for policy packs
│   ├── acp/
│   │   ├── adapter.ts            # spawn + JSON-RPC framing over stdio
│   │   ├── session.ts            # run lifecycle, watchdogs, normalization (§6)
│   │   ├── result.ts             # LIGHTSOUT_RESULT sentinel parsing (§6.4)
│   │   └── advisor.ts            # ephemeral read-only second-opinion sessions (§8.2)
│   ├── orchestrator/
│   │   ├── orchestrator.ts       # chain loop, project locks (§5)
│   │   ├── phases.ts             # phase materialisation, gates, skip/relaunch (§16)
│   │   ├── verify.ts             # verify gate execution (OR-04)
│   │   ├── doubts.ts             # doubt lifecycle (§8)
│   │   └── recovery.ts           # boot-time recovery (§11.2)
│   ├── projects/
│   │   ├── scaffold.ts           # create_project from template (PM-01)
│   │   ├── docs.ts               # STATE/PLAN/DECISIONS/QUESTIONS managed sections (§9.2)
│   │   └── git.ts                # simple-git: wip, consolidate, checkpoint, push (§9.3)
│   ├── mcp/
│   │   ├── server.ts             # tool registration, /mcp streamable HTTP
│   │   ├── stdio-bridge.ts       # separate entry: stdio ⇄ HTTP proxy (§10.1)
│   │   └── tools/                # one module per tool (§10.2)
│   ├── control/
│   │   └── actions.ts            # the one entry point both MCP tools and panel routes call (§12.0)
│   └── http/
│       ├── server.ts             # Fastify: static panel, JSON API, /health
│       ├── api-read.ts           # SELECT-only routes (§12.1)
│       ├── api-write.ts          # the enumerated mutating routes (§12.1b, SU-05)
│       ├── setup.ts              # first-run wizard routes (§14.3)
│       └── sse.ts                # /api/stream (§12.2)
├── panel/                        # static, no build step (ST-04)
│   ├── index.html
│   ├── app.js                    # hash router + SSE client + renderers
│   └── style.css                 # dark theme (WP-08)
├── builtin/                      # shipped inside the image, read-only at runtime (BA-01, TP-02)
│   ├── agents/*.yaml             # the ten builtin profiles (§19)
│   ├── policies/*.yaml           # policy packs the builtins reference
│   └── templates/*.yaml          # the four builtin project templates (§16.3)
├── scaffold/                     # renamed from templates/project/ in phase 9; see below
│   ├── lightsout.yaml            # per-project config (§9.1)
│   └── doc/{STATE,PLAN,DECISIONS,QUESTIONS}.md
├── examples/
│   └── agents/                   # legacy sample profiles; superseded by builtin/ (kept for the phase 3 gates)
├── extension/                    # Claude Desktop extension source, packed to dist/lightsout.mcpb (SU-09)
└── scripts/
    ├── login-claude.sh           # docker exec -it … interactive login (RT-04)
    ├── login-codex.sh
    ├── install.sh                # host-side bootstrap: checks docker, creates workspace, copies .env
    ├── verify/                   # one phase gate per phase (§13)
    └── windows/                  # Start-LightsOut.ps1, Connect-Engine.ps1, … (§14.3b, SU-10)
```

`src/net/forwarder.ts` (§14.4) and `src/cli/` (`run-task.ts`, `run-chain.ts`, `login.ts`) exist
too; they are omitted above only to keep the tree readable.

**The `templates/` name collision.** Before this change, `templates/project/` in the repo held
the *project scaffold* while `templates/` in the workspace now holds *project templates* (TP-01)
— the same word for two unrelated things, and both would ship into the image at the same path.
The scaffold moves to `scaffold/` in phase 9. Until that rename lands, code and the Dockerfile
still say `templates/project/`.

Runtime workspace, a folder on the user's own machine bind-mounted at `/workspace` (RT-02).
The default is `%USERPROFILE%\Documents\LightsOut` on Windows and `~/LightsOut` elsewhere; the
wizard can point it somewhere else. Everything the user might want to open, edit or back up
lives here and nowhere else. A managed Docker volume remains supported for headless installs
by setting `LO_WORKSPACE_MODE=volume`.

```
$LIGHTSOUT_WORKSPACE/
├── agents/
│   ├── policies/                # policy packs; a file here shadows the builtin of the same id
│   └── *.yaml                   # agent profiles; a file here shadows the builtin of the same id
├── templates/
│   └── *.yaml                   # project templates; same shadowing rule (TP-04)
├── knowledge/
│   └── <base-id>/
│       ├── knowledge.yaml       # manifest: kind, description, tags, owner, updated (KB-01)
│       ├── index.md             # always injected; one line per document
│       └── *.md                 # the curated documents
├── vault.yaml                   # credentials and URLs for probing (VT-01); git-ignored, never in the DB
└── projects/
    └── <project-slug>/          # own git repo, doc/, source
```

Layering is the same rule everywhere: the loader reads `builtin/<kind>/` first, then the
workspace directory, and an entry whose id already exists is replaced wholesale (no field
merge — a shadowing file is a complete definition, so what the panel wrote is what runs).
`builtin/` is never written to at runtime, so `docker pull` updates the library without
touching anything the user changed.

## 3. Container and configuration

### 3.1 Dockerfile (RT-01, ST-05)

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/*
# Engine CLIs and ACP adapters. Pin exact versions at implementation time.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
      <claude-acp-adapter-pkg> <codex-acp-adapter-pkg>
# Python for contract-prober only (ST-06). Pinned; nothing else in the system uses it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
      && rm -rf /var/lib/apt/lists/* \
      && python3 -m venv /opt/probe-venv \
      && /opt/probe-venv/bin/pip install --no-cache-dir 'httpx==<pin>'
RUN useradd -m -u 1000 app
WORKDIR /opt/lightsout
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY panel/ ./panel/
COPY builtin/ ./builtin/          # the agent, policy and template library (BA-01, TP-02)
COPY scaffold/ ./scaffold/        # the project scaffold copied by create_project (PM-01)
USER app
ENTRYPOINT ["tini","--"]
CMD ["node","dist/index.js"]
HEALTHCHECK --interval=30s --timeout=5s CMD node dist/healthcheck.js
```

Note: the exact npm package names of the ACP adapters are resolved and pinned during implementation (the `agentclientprotocol` org publishes both). The adapter launch commands are configurable (`LO_ADAPTER_CLAUDE`, `LO_ADAPTER_CODEX`), so a rename never requires a code change.

### 3.2 docker-compose.yml

```yaml
services:
  lightsout:
    build: .
    container_name: lightsout
    restart: unless-stopped
    ports:
      - "127.0.0.1:${LO_PORT:-8484}:8484"     # panel + API + /mcp (WP-09)
      - "127.0.0.1:1455:1455"                 # engine OAuth callback (SU-04)
    volumes:
      - ${LIGHTSOUT_WORKSPACE:-~/LightsOut}:/workspace  # RT-02 default: host folder
      - lightsout-db:/data                     # DB-01
      - claude-auth:/home/app/.claude          # RT-03
      - codex-auth:/home/app/.codex            # RT-03
      # - ${SSH_DIR:-~/.ssh}:/home/app/.ssh:ro # optional, git push (PM-05)
    environment:
      - LO_BIND=0.0.0.0        # container-internal; host binding is 127.0.0.1 above
      - LO_DB=/data/lightsout.db
      - LO_WORKSPACE=/workspace
      - LO_WORKSPACE_MODE=${LO_WORKSPACE_MODE:-host}
    env_file: .env
volumes:
  lightsout-db:
  claude-auth:
  codex-auth:
```

For `LO_WORKSPACE_MODE=volume` (headless installs) the workspace line becomes
`lightsout-workspace:/workspace` and the volume is declared; `docker-compose.volume.yml` carries
that one override rather than commenting lines in and out of the main file. The database stays a
managed volume in both modes: it is not something a user should be editing, and WAL on a bind
mount is a category of problem worth avoiding.

### 3.3 Outbound network allowlist (RT-05)

Pilot mechanism: an egress HTTP(S) proxy sidecar (tinyproxy) with an allowlist filter; the lightsout service gets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` pointing at it and its network has no default route except the proxy. Both engine CLIs and git honor proxy env vars. Default allowlist: `api.anthropic.com`, `*.claude.ai` (subscription auth), `api.openai.com`, `auth.openai.com` (Codex auth), plus the git remote hosts declared in project configs. The compose file ships with the proxy enabled under a `secure` profile; running without the profile is allowed but the panel health page reports `network: unrestricted` (honest signal, not silent).

### 3.4 Environment variables (single source: `src/config.ts`)

| Var | Default | Purpose |
|---|---|---|
| `LIGHTSOUT_WORKSPACE` | `%USERPROFILE%\Documents\LightsOut` / `~/LightsOut` (host side) | Host folder bind-mounted at /workspace; this is where the user's projects live (RT-02) |
| `LO_WORKSPACE_MODE` | `host` | `host` (bind mount) or `volume` (managed volume, headless installs) |
| `LO_WATCH_POLL_MS` | `2000` | Poll interval for the agent, template and knowledge loaders; bind mounts do not deliver reliable inotify events (AP-03) |
| `LO_KNOWLEDGE_BUDGET_CHARS` | `120000` | Injection budget for attached knowledge documents (KB-06) |
| `LO_VAULT_FILE` | `/workspace/vault.yaml` | Credentials vault (VT-01); git-ignored, never read into SQLite |
| `LO_PORT` | `8484` | Host port for panel/API/MCP |
| `LO_DB` | `/data/lightsout.db` | SQLite path |
| `LO_MAX_PARALLEL` | `3` | Max concurrent runs across projects (SR-07) |
| `LO_TIMEOUT_QUICK_MIN` | `30` | Hard timeout, quick level (SR-04) |
| `LO_TIMEOUT_FULL_MIN` | `90` | Hard timeout, full level |
| `LO_INACTIVITY_MIN` | `8` | Inactivity watchdog (SR-04) |
| `LO_PERMISSION_WAIT_HOURS` | `24` | Max wait on a human-gated permission before cancel (§8.4) |
| `LO_ADVISOR_CONFIDENCE` | `0.7` | Threshold for auto-continue on second opinion (DO-02) |
| `LO_SCRIPT_SCAN_BYTES` | `65536` | Max bytes of a script body read to classify it; larger scripts are never `script_exec` (PE-07, §7.1) |
| `LO_ADAPTER_CLAUDE` | `claude-agent-acp` | Command to spawn the Claude ACP adapter |
| `LO_ADAPTER_CODEX` | `codex-acp` | Command to spawn the Codex ACP adapter |
| `LO_EVENT_RETENTION_DAYS` | `90` | Event pruning (DB-04) |
| `GIT_TOKEN` / mounted `~/.ssh` | — | Push credentials (PM-05, NF-02) |

Config is parsed once with zod at boot; invalid config aborts startup with a readable error.

## 4. Database schema (DB-01..04)

SQLite, WAL mode, `foreign_keys=ON`, `busy_timeout=5000`. All timestamps are ISO-8601 UTC strings. All JSON columns are TEXT with a `json_valid()` CHECK. Full DDL (`src/db/schema.sql`):

```sql
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
  template_id   TEXT,                          -- template it was created from (TP-05, PM-07)
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

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,                -- ulid
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  project_id  TEXT NOT NULL REFERENCES projects(id),
  position    INTEGER NOT NULL,                -- order within chain (OR-01)
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,                   -- full prompt/acceptance criteria
  agent_id    TEXT NOT NULL,                   -- profile id (AP-01)
  engine      TEXT,                            -- migration 8: launch override, NULL = the profile's (AP-09)
  model       TEXT,                            -- migration 8: idem
  reasoning   TEXT,                            -- migration 8: idem
  level       TEXT NOT NULL CHECK (level IN ('quick','full')),
  verify_cmd  TEXT,                            -- overrides project verify_cmd
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','ok','doubt','verify_failed',
                                'timeout','stuck','error','aborted','interrupted')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (chain_id, position)
);

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
  tokens_in     INTEGER, tokens_out INTEGER,
  cost_usd      REAL,                          -- NULL when engine does not report (Codex)
  wip_commit    TEXT, final_commit TEXT,
  summary       TEXT,                          -- agent's final summary (plain language)
  error         TEXT
);

CREATE TABLE events (                          -- append-only; powers panel + history (DB-02, OB-01)
  id        INTEGER PRIMARY KEY AUTOINCREMENT, -- also the SSE Last-Event-ID cursor
  run_id    TEXT REFERENCES runs(id),          -- NULL for system-level events
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,                     -- see §4.1
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
  kind           TEXT NOT NULL CHECK (kind IN ('functional','permission','gate')),
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
  id             TEXT PRIMARY KEY,
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

CREATE TABLE project_phases (                  -- materialised from the template at creation (TP-05, TP-06)
  id            TEXT PRIMARY KEY,              -- ulid
  project_id    TEXT NOT NULL REFERENCES projects(id),
  position      INTEGER NOT NULL,
  phase_id      TEXT NOT NULL,                 -- id from the template, or 'adhoc-<n>' (TP-08)
  title         TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  instructions  TEXT NOT NULL,                 -- phase instructions, frozen at creation (TP-05)
  deliverable   TEXT,                          -- expected path or description (BA-04)
  verify_cmd    TEXT,
  gate          TEXT NOT NULL DEFAULT 'auto' CHECK (gate IN ('auto','human')),
  optional      INTEGER NOT NULL DEFAULT 0,
  repeatable    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','failed','skipped')),
  task_id       TEXT REFERENCES tasks(id),     -- the task currently or last representing it
  started_at    TEXT, ended_at TEXT,
  UNIQUE (project_id, position),
  UNIQUE (project_id, phase_id)
);
CREATE INDEX ix_phases_project ON project_phases(project_id, position);

CREATE TABLE project_knowledge (               -- KB-03, PM-07
  project_id    TEXT NOT NULL REFERENCES projects(id),
  base_id       TEXT NOT NULL,                 -- knowledge/<base_id>
  kind          TEXT NOT NULL,                 -- copied from the manifest at attach time
  writable      INTEGER NOT NULL DEFAULT 0,    -- only the curation template sets this (KB-05)
  attached_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, base_id)
);

CREATE TABLE vault_audit (                     -- VT-05; entry ids and field names only, never values
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  ts         TEXT NOT NULL,
  entry_id   TEXT NOT NULL,
  fields     TEXT NOT NULL CHECK (json_valid(fields))
);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

`project_phases` is the answer to "what is done, what is running, what is pending" (TP-06,
WP-10) and the reason phases are not merely tasks: a phase survives its task. Re-launching a
repeatable phase creates a new task and repoints `task_id`, while the phase keeps its
position, its gate and its history in `events`. `tasks` stays exactly as it is; the phase row
is the durable plan, the task row is one attempt at it.

Doubt identity: `id` is a ulid like every other entity; `ref` is the human-friendly label
(`D-3`) numbered per project and unique within it. Everything user-facing (panel, MCP
responses, doc mirrors) shows `ref`; foreign keys use `id`.

Aggregations (costs per project/day, runs by state — OB-05) are SQL views over `runs`, not separate tables.

### 4.1 Event types (`events.type`)

| type | payload (JSON) | emitted when |
|---|---|---|
| `run.state` | `{status, reason?}` | any run status transition |
| `task.state` | `{taskId, status}` | any task status transition |
| `chain.state` | `{chainId, status}` | chain transitions |
| `agent.message` | `{textExcerpt}` | agent message chunk boundary (throttled: last line, max 1/2s) |
| `tool.call` | `{kind, title, path?}` | ACP tool call started |
| `file.edit` | `{path, op}` | ACP fs write/patch applied |
| `perm.request` | `{class, title}` | permission request received |
| `perm.verdict` | `{class, verdict, ruleSource}` | policy engine answered |
| `doubt.opened` / `doubt.answered` | `{doubtId}` | doubt lifecycle |
| `advisor.consulted` | `{engine, agrees, confidence}` | second opinion returned |
| `verify.start` / `verify.result` | `{cmd}` / `{exitCode, tailOutput}` | verify gate |
| `git.commit` / `git.tag` / `git.push` | `{sha|tag, message}` | git operations |
| `system.auth` | `{engine, status}` | auth state change detected |
| `phase.state` | `{phaseId, phaseRef, status, actor}` | phase transition, including skip and relaunch. `phaseId` is the `project_phases.id` ulid, `phaseRef` the template-level `phase_id` humans read (TP-06) |
| `config.changed` | `{kind, id, actor}` | an agent, template, knowledge manifest or vault entry was written, deleted or reloaded; `kind` is `agent\|policy\|template\|knowledge\|vault` and the payload never carries a value (AP-06, TP-04, VT-03, WP-11) |
| `knowledge.attached` / `knowledge.detached` | `{baseId, kind, actor}` | knowledge attachment changed (KB-03) |
| `vault.read` | `{entryId, fields}` | a run read a vault entry; never values (VT-05) |
| `scratch.swept` / `scratch.sweep_failed` | `{files, bytes}` / `{error}` | the scratch directory was emptied at run close, or could not be (PE-08, §5.2b) |
| `run.untracked` | `{count, paths}` | the run left untracked files outside the scratch directory; reported, not deleted (PE-08) |

`actor` is `'mcp'`, `'panel'` or `'system'` on every event a human can trigger from either
surface (WP-11). It is how the history explains who did what when both surfaces are in use.

The "last action" shown on the panel (WP-05) is the most recent event of type `agent.message`, `tool.call`, `file.edit` or `verify.*` for the active run. Inactivity is `now − max(events.ts)` for that run.

## 5. Orchestrator (OR-01..08)

### 5.1 State machines

Task:

```
queued ──▶ running ──▶ ok ──▶ (next task starts)            OR-02
              │
              ├──▶ doubt ───────answer──▶ running (resume)   §8
              ├──▶ verify_failed ┐
              ├──▶ timeout       │  chain → paused; recovery
              ├──▶ stuck         │  info persisted (OR-05)
              ├──▶ error         │
              ├──▶ aborted       │  (human abort, OR-06)
              └──▶ interrupted ──┘  (container restart, RT-07)
```

Chain: `active → paused` on any non-ok task end (except doubt auto-resolved); `active → completed` when last task is ok; `→ aborted` on abort_chain. A paused chain resumes when the blocking task is retried/resumed and ends ok.

### 5.2 Chain loop (pseudocode)

```
onTaskFinished(task, result):
  persist run row, final events
  hygiene.sweep(project, run)                     # PE-08, before anything commits
  if result == ok:
      git.consolidate(task)                       # PM-04
      docs.updateState(project)                   # PM-02
      if verifyCmd(task): run verify              # OR-04
         if fail: task=verify_failed; chain=paused; return
      if project.push_policy == 'auto' and verify green: git.push()   # PM-05
      next = nextQueuedTask(chain)
      if next: start(next) else chain=completed
  else if result == doubt: handled by doubt flow (§8); chain stays active but waiting
  else: task=<failure state>; chain=paused; persist recovery info
```

### 5.2b Hygiene sweep (PE-08, `src/projects/hygiene.ts`)

Called on **every** terminal outcome, including failures and doubts, and before the consolidated
commit, so temporary files never enter history:

1. `<project>/.lightsout/tmp/` is emptied — its contents removed, the directory kept. An event
   `scratch.swept` records `{files, bytes}`; nothing is recorded when it was already empty.
2. `git status --porcelain` lists what the run left behind. Untracked paths outside the scratch
   directory are recorded as `run.untracked` with up to 50 paths and **are not deleted**: an agent
   that created a file on purpose and a leftover look identical from here, and deleting real work to
   tidy up is the worse error. The consolidated commit makes them visible anyway, and the panel shows
   the event on the run timeline.

The sweep never throws: a failure to clean is an event (`scratch.sweep_failed`), not a reason to lose
a finished task. Sweeping is confined to the scratch directory by construction — it resolves the path
and refuses to act unless it is inside the project.

### 5.3 Concurrency and locks (SR-07, OR-08)

- In-memory `Map<projectId, runId>` is the project lock; consistent because there is exactly one process.
- `launch_task`/`launch_chain` against a locked project enqueues (task status stays `queued`) and returns `{queued: true}`.
- A global semaphore caps concurrent runs at `LO_MAX_PARALLEL`.
- Crash consistency: locks are memory-only; on boot, recovery (§11.2) marks any `running`/`waiting_human` runs as `interrupted` before locks are rebuilt, so a stale lock can never survive a restart.

### 5.4 Stopping work that is already running (OR-06, OR-09, SR-06)

`RunSession.abort()` cancels the ACP turn and stops the adapter, and has done since phase 3 — but
the session object lived in a local variable inside the runner, so nothing outside could reach it.
`abort_run` could therefore only drop the queue, and the agent kept working and kept writing files.
That is the gap this section closes.

**`src/acp/live.ts` — `LiveRuns`.** One entry per session currently driving an adapter, keyed by run
id, carrying `{runId, taskId, projectId, chainId, abort(), acpSession(), startedAt}`. The runner
registers a session immediately after creating it and unregisters it in a `finally`, so the map is
never a lie about what is running. Memory only: a process restart kills every adapter with it and
the boot recovery pass (§11.2) reconciles the rows.

**`orchestrator.stopRun(runId, reason)`** — the full stop:

1. Release any permission gate the run is holding (`DoubtService.cancelForRun`): the held ACP
   request is answered as refused and the doubt is closed with "cancelled: the run was stopped", so
   an abandoned gate does not sit in the attention strip forever.
2. `handle.abort()` → `session/cancel`, then the adapter process, SIGTERM then SIGKILL after
   `CANCEL_GRACE_MS`. The session's own outcome becomes `aborted` and travels the ordinary path:
   the run row is finished, the task is `aborted`, the sweep of §5.2b still runs.
3. No live handle? Then nothing is running. If the row still claims `running` or `waiting_human` it
   is reconciled to `interrupted` with its recovery info, and the answer says `stopped: false` —
   an honest "there was nothing to stop" instead of a silent success.

**Chain abort = stop plus drop.** `abortChain(chainId, {letCurrentFinish})` marks the chain
`aborted`, drops the queued tasks and, unless `letCurrentFinish` is set, stops the live run first.
Aborting a chain and leaving its agent typing was the surprising behaviour; it is now the opt-in.

Two consequences worth stating. The chain loop must not pause a chain that is already `aborted`:
the aborted task's outcome arrives after the abort, and `paused` would erase the user's decision.
And a stop is recorded as `run.state {status:'aborted', reason, actor}` plus a `system` event
naming who asked, so the timeline says "the user stopped this" rather than "the task failed".

### 5.5 The model is a launch decision, not a property of the agent (AP-09, OR-11)

A profile carries `engine`, `model` and `reasoning`, and until now those were the only answer: to
run `builder` on a cheaper model you had to edit the profile, launch, and remember to put it back.
That is a setting masquerading as a decision. The same agent doing the same job is worth `haiku`
when the task is mechanical and `opus` when it is not, and the person launching it is the one who
knows which.

**The profile is the default; the launch may override it.** `launch_task`, `launch_chain` (whole
chain or per task) and `launch_phase` all accept optional `engine`, `model` and `reasoning`.
Nothing is written to the profile on disk — AP-01 keeps the workspace file as the source of truth,
and an override that silently rewrote it would change every later launch.

**Effective profile.** `resolveProfile(profile, task)` in `src/agents/effective.ts` is the one
place the merge happens: the profile, overridden field by field by whatever the task carries.
`TaskRunner.run` calls it immediately after `profileOrThrow` and uses the result for everything
downstream — the adapter command (a `codex` override means the Codex adapter, not Claude's), the
`runs` row, the prompt and the session. Nothing else reads `profile.model` directly, so the two
cannot drift.

**Storage is migration 8**: `tasks.engine`, `tasks.model`, `tasks.reasoning`, all nullable, all
meaning "use the profile's". Nullable rather than backfilled on purpose: a task that predates this
must keep following its agent when the agent changes, and a copied value would freeze it.

**Refused at launch, not at run time (OR-11).** `Actions` validates before a task row exists:

| what is wrong | the answer |
|---|---|
| engine is not `claude` or `codex` | refused, naming both |
| the model is not in `ENGINE_MODELS[engine]` | `modelRejection()` — the same sentence AP-08 gives the panel, listing the accepted models |
| reasoning is not one of `REASONING_LEVELS` | refused, listing them |
| a model given with no engine and the profile's engine does not accept it | refused, saying which engine was assumed |
| the resolved engine is not authenticated | refused, pointing at the reconnect flow (§14.4) |

That last row is the point of OR-11: engine health is already known at launch, and a run that dies
on `AUTH_REQUIRED` two seconds in taught nobody anything. It joins the `needs` check of PE-12 — one
pass over everything a launch can be wrong about, one refusal listing all of it.

**The audit says who chose.** The `runs` row already carries `engine` and `model`; when they came
from a launch rather than the profile the run also gets
`config.changed {kind:'override', op:'launch', actor, from:{engine,model,reasoning}, to:{…}}`, and
the panel and `status_card` mark the run "model chosen at launch". A run whose model nobody can
account for is a cost nobody can explain.

**Discovery.** `list_agents` gains a `models` block — the catalog of `src/agents/models.ts`, per
engine, with the default first — because the MCP client has no other way to learn what it may
pass, and guessing produces the refusal above instead of a run. The `agents` section of `guide`
documents the override with a worked example.

## 6. ACP session runner (SR-01..08)

### 6.1 Adapter processes

One adapter child process per active run, spawned with the project directory as cwd:

```
spawn(LO_ADAPTER_CLAUDE | LO_ADAPTER_CODEX, [], { cwd: project.path, env: scrubbedEnv })
```

`scrubbedEnv` passes only what the adapter needs (PATH, HOME, proxy vars, engine config dirs); no LightsOut secrets (NF-02). Communication is JSON-RPC 2.0 over stdio per the ACP spec: `initialize` handshake (declare client fs/terminal capabilities), then `session/new { cwd, mcpServers: [] }`, then `session/prompt`.

### 6.2 Prompt composition (PM-03)

The prompt for a run is assembled from seven blocks, in order:

1. Agent profile `instructions` (AP-01).
2. LightsOut protocol block (constant, versioned): how to report results (§6.4), how to raise a doubt, reminder that permissions are mediated and denials are not failures. It also states that missing credentials are a doubt, never a guess (VT-04), and that a phase without its deliverable is a failure, never a pass (BA-04). It grants the tooling licence of PE-07 explicitly — write and run your own helper scripts, no permission needed — and names `.lightsout/tmp/` as the place for temporary files, saying plainly that it is emptied at the end of the run and that anything left elsewhere is committed and reported (PE-08).
3. Curated knowledge (§17): the manifests and `index.md` of every attached base, plus the documents selected by budget, each labelled with its base id and kind so organisational context is not mistaken for technical fact (KB-04).
4. Project context: managed section of `STATE.md`, open items of `PLAN.md`, last N entries of `DECISIONS.md` (N=10 default).
5. Phase block (§16.2): the phase title, its frozen `instructions`, its expected deliverable, and where the previous phase left its own deliverable.
6. Task spec (`tasks.spec`) with acceptance criteria and verify command if any.
7. Vault index for entries in scope: labels, base URLs and field names of what is available, and the environment variable each will arrive in. Values are never in the prompt (VT-02).

Knowledge comes before project context deliberately: it is the stable background, while
`STATE.md` is the moving foreground, and the foreground should be what the model read last.

### 6.3 Event normalization (SR-02)

The session module subscribes to ACP notifications and maps them to `events` rows (§4.1) inside a single prepared-statement transaction per notification. Agent message streaming is throttled: intermediate chunks update an in-memory "last line" (pushed over SSE as ephemeral), and a row is written at most every 2 s and always on turn end. This keeps `events` useful without writing every token.

### 6.4 Result sentinel

The protocol block instructs the agent to end its final message with:

```
<<<LIGHTSOUT_RESULT
{"status":"ok"|"doubt","summary":"one paragraph, plain language",
 "doubt":{"context":"…","blocks":"…","options":[{"id":"A","text":"…"},{"id":"B","text":"…"}],
          "recommendation":"A"} }
>>>
```

`result.ts` extracts and validates it (zod). Missing/invalid sentinel with a clean turn end → status `ok` with `summary = last message excerpt` and a `system` warning event (agents occasionally forget; do not fail the run for it). A `status:"doubt"` sentinel feeds §8.

### 6.5 Permission mediation (SR-03, PE)

```
ACP session/request_permission ──▶ classify.ts ──▶ engine.evaluate()
    verdict allow        → respond with the "allow" option            (audit row)
    verdict deny         → respond "reject"; inject a short user turn explaining
                           the denial and the expected alternative     (audit row)
    verdict provisional  → respond "allow" + git checkpoint tag + decision row (PE-06)
    verdict require_human→ run.status = waiting_human; create doubt(kind='permission');
                           HOLD the ACP response until answer_doubt   (§8.4)
```

While `waiting_human`, both watchdogs are suspended (the session is idle by design) and a slow clock (`LO_PERMISSION_WAIT_HOURS`) applies instead.

### 6.5b The permission judge (PE-11)

**Why, after PE-09 and PE-10.** Widening the classifier covers what we already know; learning covers
what a human has already answered. Neither helps the *first* time an unrecognised command appears at
three in the morning, and that is the case that costs eleven minutes of a chain to count lines.

So before a `require_human` verdict becomes a doubt, one closed question goes to a judge:

```
agent    permission-judge   (claude / haiku / low, policy `advisor`: read-only, terminal denied)
input    the command, the class the policy gave it and why, the project directory, the read-only
         areas, the write scopes, and the two questions it must answer
output   {"verdict":"allow"|"escalate","risk":"none"|"low"|"high","reason":"…","concerns":[…]}
timeout  LO_JUDGE_TIMEOUT_MS (20 s). Slow is the same as unsure.
```

The two questions, and they are the whole prompt's point: **can this damage the system** (the
container, the engines' configuration, credentials, anything outside the project) and **can this
damage the user's work** (source, documents, git history, the knowledge base)? A command that can do
neither is allowed; anything else escalates.

**What it may decide, and nothing else:**

| class | judge | why |
|---|---|---|
| `other` | yes | the classifier did not recognise it; this is where the noise lives |
| `delete` | yes, only when every target resolves inside the project | `rm -rf build` is housekeeping; a deletion elsewhere is not the judge's to make |
| `deps_install`, `network` | no by default; **yes in unattended mode** (OR-12, §7.7) | they change the build environment or leave the machine (ST-03), which is worth a person's attention when there is a person |
| `credentials` **owned by this project's vault** | yes (PE-13, §7.1d) | the run was handed that key deliberately; gating each use contradicts VT-07 |
| `credentials` otherwise, `publish_external`, `outside_workspace`, force push | no | the hard floor of PE-03, unchanged and unreachable from here |

**Failure is a human, always.** A timeout, a crash, an unparseable answer, a `risk: high`, an
engine that is not authenticated — every one of them opens the doubt exactly as before. The judge
can only ever *shorten* the path to allow; it cannot lengthen the path to deny.

**What an allow leaves behind:** a `provisional` decision row with the judge's reason (PE-06), a
`perm.verdict` event carrying `judge: allow, risk: none`, an audit row, and a learned shape (PE-10)
marked `added_by: judge` — so the same shape is free next time, listed separately from the ones a
human allowed, and revocable with `forget_learned_allow`.

**Order of the gate**, from cheapest to most expensive:

1. the classifier (§7.1) — microseconds
2. a learned shape (PE-10) — one indexed read
3. the judge (this section) — one cheap turn, ~2 s
4. the advisor (§8.2) — the other engine, for the doubts that are decisions rather than risks
5. the human

### 6.6 Watchdogs (SR-04)

Per run: hard timer (`quick`→`LO_TIMEOUT_QUICK_MIN`, `full`→`LO_TIMEOUT_FULL_MIN`, task override allowed) and inactivity timer re-armed on every persisted event. Expiry: `session/cancel`, grace 10 s, `SIGTERM` the adapter, status `timeout`/`stuck`, recovery info persisted (acp_session id enables resume where supported, SR-06).

### 6.7 Cost capture (SR-05)

From ACP turn metadata when the adapter reports usage; `cost_usd` stays NULL otherwise (Codex reports tokens only — mirrored from the current system's experience). Never estimated.

### 6.8 Steering a run that is already going (SR-09, MC-15)

**The failure this fixes.** A run is doing the right thing badly, or the user learns something the
run needs, and the only verbs are `stop_run` and `abort_run`. Everything the agent has understood so
far is thrown away to say one sentence to it.

**What is not possible, and why.** Two obvious ideas are dead ends, and they are written down here
so nobody spends another afternoon on them. First, the permission response cannot carry a message:
ACP's `RequestPermissionResponse` is `{outcome: "selected", optionId}` or `{outcome: "cancelled"}`,
and nothing else — the `explanation` of a rejection already ends up in the timeline rather than in
the agent's context (`session.ts`). Second, there is no mid-turn injection: a turn is one
`session/prompt` call, and the adapter will not accept a second while it is in flight.

So a note reaches the agent by two routes, and the second one does not need its cooperation.

1. **The inbox file, read while the turn runs.** `steer_run` appends to
   `.lightsout/inbox.md` in the project. The protocol block (MC-11) tells every agent to read that
   file before each significant step and to honour what it finds. Immediate when the agent obeys,
   and free when it does not.
2. **A steering turn at the end of the turn.** When the turn ends, the runner asks for notes that
   have not been delivered yet; if there are any, it sends them as a **new prompt on the same
   session** and keeps going. The agent keeps its whole context — files read, decisions made — and
   answers the correction instead of being killed for it. Capped at `MAX_STEERING_TURNS = 3` so a
   note that arrives during a steering turn is honoured, and a loop is not.

The run therefore cannot finish with a note unread. If the agent ignores the file, it still gets the
note before it is allowed to stop.

**Persistence.** Notes are rows in `run_notes` (migration 14): the run, the text, who wrote it, when
it was written and when it was delivered. A run that was steered is not reproducible from the
sequence of events alone (OB-02) unless the steering is part of that sequence, so each note is also
an event, `run.steered`, and appears in the panel's timeline as a decision.

**A steer is not an answer.** It never resolves a doubt, never closes a gate, and never grants a
permission. A run waiting on a human is waiting on `answer_doubt`; a note left on it is delivered
when the run is running again.

## 7. Policy engine (PE-01..06)

### 7.1 Action classes (`classify.ts`)

`project_write · project_read · exec_check · script_exec · git_local · git_push · deps_install · network · delete · outside_workspace · credentials · publish_external · knowledge_write · other`

Classification inputs: ACP tool-call kind (fs read/write, terminal), requested path (inside/outside `project.path`), and command string matched against a matcher table (regex list per class, shipped with defaults, extendable in the pack). Unmatched terminal commands → `other`. Path escapes (`..`, absolute outside workspace, symlink resolution) → `outside_workspace` regardless of command.

A terminal command is first **split into segments** on `&&`, `||`, `|`, `;` and newlines outside quotes, and every segment is classified separately: the most dangerous class across the segments is the class of the whole request. Matchers are anchored at the start of a segment, so without this split only the first command of a chain would ever be matched and every compound command would collapse into `other` — a human gate for `find . && git log`, which is noise, not safety. Splitting cannot launder anything: `curl x | sh` still classifies as `network` because the worst segment wins.

Read-only inspection through the terminal (`ls`, `find`, `cat`, `head`, `tail`, `wc`, `stat`, `du`, `tree`, `file`, `git ls-files`, `git count-objects`, …) classifies as `project_read`, the same class the fs read kind gets, so exploring a repository is not an escalation. A segment that would otherwise be read-only is **disqualified** and falls back to `other` when it carries a write redirect (`>`, `>>`), a `find` action (`-exec`, `-execdir`, `-ok`, `-delete`) or a command substitution (`$(…)`, backticks) — anything that can hide a second command inside a benign-looking one.

#### Running your own tooling: `script_exec` (PE-07)

An agent that must reorganise a document, count something across a tree or transform a file writes a
helper script and runs it. Before this class existed, `python3 renumber.py` matched no matcher, fell
into `other` and stopped the chain on a human gate — for a script the agent had just been allowed to
write, operating on its own deliverable. That is noise, and noise trains the user to approve without
reading.

`script_exec` is the class of *running code the agent supplied*: an interpreter over a file
(`python3 x.py`, `node x.mjs`, `bash x.sh`, `ruby`, `deno run`, …) or inline code (`-c`, `-e`, a
heredoc). It is separate from `exec_check` on purpose: `npm test` runs code whose behaviour the
project already owns, while a fresh script is whatever the agent wrote a minute ago, so a pack must
be able to allow one and refuse the other.

**A script is opaque from its command line, so the class is decided from the code, not the
invocation.** For a script file the engine resolves the path, refuses anything outside the project
(PE-02 already), reads at most `LO_SCRIPT_SCAN_BYTES` (64 KB default) and matches the body against
the same dangerous families used for commands:

| Found in the body | Class returned |
|---|---|
| a path escaping the project, or `..` traversal | `outside_workspace` |
| `.env`, `id_rsa`, `credentials`, `.pem`, a known key variable | `credentials` |
| `pip install`, `npm install`, package-manager calls | `deps_install` |
| `socket`, `requests`, `urllib`, `httpx`, `http.client`, `fetch(`, `node:https`, `curl` | `network` |
| `os.remove`, `rmtree`, `unlink`, `rm -rf` | `delete` |
| `subprocess`, `os.system`, `child_process`, `exec(`, `eval(` | `other` (a human sees it) |
| none of the above | `script_exec` |

The families are tested in that order, which is why dependencies come before network: `pip install
requests` is a dependency, and the package name would otherwise read as a network library.

A body that cannot be read, is larger than the scan limit, or is not on disk yet is **never**
`script_exec`: it falls to `other`, which is a human. The same table is applied to inline code, where
the body is the command's own argument. The reason string names what matched, so the audit row and
any doubt say why.

What this buys and what it does not: the boundary moves from "commands LightsOut can read" to "code
LightsOut has read". A determined script can still do anything the container can, so the remaining
containment is the container itself (no host access), the egress allowlist (RT-05), the git diff of
every run and the audit trail. It is a deliberate trade: the alternative is a human gate on every
helper script, which is worse security in practice because it is ignored.

Two paths need naming explicitly now that the workspace holds shared material (§2):

- Writes under `/workspace/knowledge/<base>/` classify as `knowledge_write` when that base is
  attached to this project with `writable=1` (KB-05), and as `outside_workspace` otherwise —
  which the packs fix at `deny` and PE-03 keeps there. So writing into someone else's knowledge
  base is denied outright, not escalated to a human, because there is no legitimate case for it.
- Writes under `/workspace/agents/`, `/workspace/templates/` or to the vault file always
  classify as `credentials`, regardless of pack, so an agent can never reconfigure the system
  that is running it. That is a hard floor like PE-03.
- **Declared read-only areas (PE-09).** A project may declare directories of the workspace outside
  its own that it is allowed to *read*. A path inside one of them classifies as `project_read`
  instead of `outside_workspace`; a write to one stays `outside_workspace` and is denied by the hard
  floor, whatever the pack says. This is what turns the real failure of 2026-07-26 — an analyst
  told where the code was, unable to `ls` it, unable to copy it, and stuck in a loop of writing
  reports about being stuck — into a read the policy allows. See §9.5 for the model and its limits.
- Writes under `<project>/.lightsout/tmp/` are `project_write` **and are exempt from
  `write_scopes`** (PE-08). A `read-only` agent whose writes are confined to `doc/` still needs
  somewhere to put a helper script and its intermediate output; without this exemption the only
  place it could write its tooling is its own deliverable. The scratch directory is emptied at the
  end of every run (§5.2), so nothing an agent leaves there survives it.

### 7.2 Policy pack format (`agents/policies/*.yaml`)

```yaml
id: default
rules:                      # first match wins, evaluated top-down
  - { class: project_read,      verdict: allow }
  - { class: project_write,     verdict: allow }
  - { class: exec_check,        verdict: allow }
  - { class: script_exec,       verdict: allow }   # own tooling, body inspected (PE-07)
  - { class: git_local,         verdict: allow }
  - { class: deps_install,      verdict: require_human }
  - { class: delete,            verdict: require_human }
  - { class: git_push,          verdict: deny }    # push is the orchestrator's job (PM-05)
  - { class: network,           verdict: deny }
  - { class: knowledge_write,   verdict: deny }    # only the curation pack allows it (KB-05)
  - { class: outside_workspace, verdict: deny }
  - { class: credentials,       verdict: require_human }
  - { class: publish_external,  verdict: require_human }
  - { class: other,             verdict: require_human }
matchers:
  exec_check:
    - '^(npm|pnpm|yarn) (test|run (test|build|lint|typecheck))\b'
    - '^(node|tsc|eslint|prettier|pytest|go test)\b'
  deps_install:
    - '^(npm|pnpm|yarn) (i|install|add)\b'
  project_read:
    - '^(ls|find|stat|du|tree|file|wc)\b'
```

Pack matchers are merged onto the built-in table and matched against each segment, not against the raw command line.

### 7.3 Evaluation and layering (PE-05)

`evaluate(request)`: classify → look up the class in, in order, project override pack (`lightsout.yaml`), agent profile pack, `default` pack → first hit wins; record `rule_source`. Hard floor (PE-03, not overridable): `outside_workspace` can never resolve to allow; `credentials`, `publish_external` and force-push can never resolve below `require_human`. Every evaluation writes a `permission_audit` row (PE-04). Target latency < 5 ms (pure in-memory tables).

### 7.1b Text is not intent: three false positives that stopped a run (2026-07-26)

All three came from matching words rather than what the code does, and all three cost a real run:

| command | was | is | why it was wrong |
|---|---|---|---|
| `python3 -c "…os.environ.get('LO_VAULT_EFEMIS_PASSWORD')… print('present')"` | `credentials` | `script_exec` | `PASSWORD` inside a variable *name*. The agent was checking its own wiring; it printed `present`, never a value. And `credentials` is on the hard floor, so neither the judge nor a learned allow could rescue it — the run stopped dead. |
| `python3 -c "…find_spec('requests')…"` | `network` | `script_exec` | `requests` as a *module name*. Asking whether a library is installed is not using it. |
| `pip install --target .lightsout/tmp/deps openpyxl` | `deps_install` | `project_write` | An install into the scratch directory is swept when the run ends (PE-08), so the reason the gate exists — a dependency changes the build for every later run (ST-03) — does not apply. |

The rules now: a credential match needs a secret *file* or a value *on its way out*
(`print(os.environ…)`, `printenv SECRET`, a named API key); a network match needs an `import`, a
`require`, a call on the library, a `fetch(` or a URL; and a dependency install that names a
`--target` inside `.lightsout/tmp/` is a write, not an install.

**The same false positive, a second time, in shell.** The Python fix above did not cover the
spelling the agent actually reached for next:

```
pwd && rg --files | sort && if [ -n "${LO_VAULT_EFEMIS_PASSWORD:-}" ]; then echo 'present'; else echo 'missing'; fi
```

Two blind spots, both now closed. **A variable expanded inside a presence test is not a value going
anywhere**: `stripPresenceTests()` removes `[ … ]`, `[[ … ]]`, `test -n …` and `${X:+literal}`
before the credential patterns are applied, so the shell comparing a value and throwing it away is
not a read — while `[ -n "$T" ] && curl -H "Authorization: Bearer $T"` still is, because the use
survives the strip. And **shell keywords are not commands**: `if`, `then`, `else`, `fi`, `do`,
`done`, `while`, `for`, `case` are stripped like the process wrappers, and `[`/`test` joined the
read-only table. The whole pipeline above now classifies `project_read` and never reaches a gate at
all — not the judge, not a human.

The lesson recorded in DECISIONS.md: a fix aimed at one *spelling* of an idea is half a fix. The
question to ask of a matcher is what the command does with the value, not which characters it
contains.

### 7.2b Three packs, and the rest belongs to the agent (PE-14)

The pack picker offered ten names. Laid out as a matrix, the ten encode four independent decisions:

| pack | writes in | network | git | extra |
|---|---|---|---|---|
| `advisor`, `no-write` | — | no | no | — |
| `read-only`, `curate` | `doc/` | no | no | curate: knowledge |
| `probe` | `probes/`, `doc/` | yes | no | — |
| `test` | test directories, `doc/` | yes | yes | — |
| `default`, `web-prototype` | the project | no | yes | web-prototype: serve |
| `integrate` | the project | yes | yes | — |

Three things fall out of writing it down. `advisor` and `no-write` have **byte-identical rules** —
two names for one pack. `read-only` **is not read-only**: it writes into `doc/` and runs scripts.
And `default` differs from `integrate` by one line, as `default` does from `web-prototype`.

So a pack now answers one question — *how far is this agent trusted?* — with three answers:

| pack | what it is for |
|---|---|
| `read` | reads and reports. Runs nothing, writes nothing. |
| `build` | works inside its project: writes, runs checks and its own scripts, local git. |
| `build-network` | the same, and may reach the network. |

Everything the other seven added is a property of the **profile**, where it belongs, because it
describes *this agent*, not how far anyone trusts it:

- `writeScopes: [probes, doc]` — where this agent may write. Previously on the pack, which is why
  confining an agent meant inventing a pack for it.
- `capabilities: [knowledge_write]`, `[serve]` — the one-off permissions, named for what they are.

Network stays a pack rather than a capability, deliberately. It is the one of the four whose
consequence leaves the machine and cannot be undone (§7.5 makes the same argument about `grants`),
so it belongs where a person sees it while choosing, not in a checkbox below the fold.

**The retired ids keep loading.** `advisor`, `no-write`, `read-only`, `curate`, `probe`, `test`,
`integrate` and `web-prototype` are marked `deprecated: true`: they still resolve, so a profile
someone wrote in their own workspace does not stop working, and they are hidden from every picker
and from `list_agents.packs`. Breaking somebody's configuration is not a simplification.

### 7.1d Whose secret is it? (PE-13)

The same false positive has now stopped a real run **four times**, in four spellings:

| # | the command | what the fix was |
|---|---|---|
| 1 | `python3 -c "…os.environ.get('LO_VAULT_EFEMIS_PASSWORD')… print('present')"` | a variable *name* is not a value (§7.1b) |
| 2 | `if [ -n "${LO_VAULT_EFEMIS_PASSWORD:-}" ]; then echo present; fi` | `stripPresenceTests()` (§7.1b) |
| 3 | `grep -rqF "$LO_VAULT_EFEMIS_PASSWORD" .` | — none. This is the one that opened D-1 on `efemis-crop-map-prototype`. |
| 4 | whatever the agent reaches for next | — |

Number three survives every fix so far, and correctly so by the letter of the rule: the value *is*
expanded into another command. It is a leak **check** — `-q`, so nothing is printed — but the
classifier cannot see intent, and it never will. That is the point. **Enumerating spellings is a
losing game, and DECISIONS.md already says so after round two.** The question was wrong.

The right question is not *what does the command do with the value* but **whose value is it**:

- a `LO_VAULT_*` variable for an entry **this run resolved** is a key the system handed over on
  purpose. VT-07 goes further and grants the run the network for that entry's host. Handing an
  agent a key, opening the network to its host, and then gating every use of it is the system
  arguing with itself, and the run loses.
- anything else is untouched: a secret **file** (`.env`, `id_rsa`, `.pem`), a variable that is not
  this project's vault (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, a bare `$DB_PASSWORD`), `printenv` of
  a secret, force push, publishing.

So the classifier now records **why** a segment matched, not only that it did. `ClassifyResult`
carries `evidence: { rule, kind: "vault_own" | "vault_foreign" | "secret_file" | "key_name" | … }`.
When the whole of the evidence for `credentials` is `vault_own`, the verdict stays `require_human`
— the hard floor is not moved — but the gate is marked **judge-eligible**, and §7.4 may rescue it.

Three properties that keep this honest. The judge still fails toward the human, so a rescue is a
shortening of the path to allow and never a lengthening of the path to deny. `credentials` is still
in `NEVER_LEARNED` (PE-10), so a rescue is decided fresh every single time and no memory of it can
be wrong later. And a value on its way to a host **outside** the entry's `scope` re-classifies as
`vault_foreign` and is unreachable again — sending the EFEMIS password to a host that is not EFEMIS
is exactly the thing this class exists to stop.

### 7.1e A write the classifier cannot see is a write it must deny

`contract-prober` — Codex — could not write a single file on `efemis-crop-map-prototype`. The audit
line is one character short of empty:

```
asks permission (project_write):        → policy: deny (project_write)
```

No title, no command, and no path. Codex asks to write through **`apply_patch`**, whose ACP request
carries no `locations` at all: the paths live inside the patch envelope in `rawInput`. The
classifier read `toolCall.locations` and nothing else, so `outOfScopeWrite` saw a write into a
confined pack that named no target — and refusing that is correct, because a pack that confines
writes cannot approve one whose destination it cannot see. The rule was right; the input was blind.

What makes it embarrassing rather than merely wrong: `firstPath()` **already** looked in `rawInput`,
for the timeline (OB-06). The panel could name the file the gate claimed not to see. A narration
that knows more than the classifier is the same defect seen from two sides, and this is the second
time that pairing has cost a run — `rawInput` feeding the command classifier was the first (§OB-06).

`pathCandidates()` is now the single answer to "what does this call touch", and it reads, in order:
`locations`; the singular keys (`file_path`, `path`, `filePath`, `notebook_path`, `target`, `dest`);
the plural ones (`changes`, `files`, `paths`, `edits`, as arrays of strings, arrays of objects with
a `path`, or an object keyed by path); and finally the patch text itself —
`*** Add File: probes/probe.py` and unified-diff `---`/`+++` headers. The write scopes are then
enforced on everything it found, so a confined pack still confines: what changed is that it is now
confining something it can see.

### 7.8 The engine's own sandbox (ST-09)

The most expensive hour of 2026-07-27 was spent in the classifier, and the classifier was innocent.

`contract-prober` could not write a single file on `efemis-crop-map-prototype`. It said so plainly —
*"the first file-write was denied before execution"* — and the timeline agreed. But the audit trail
for the entire run held **one** `permission_audit` row, and it was an `allow`. A refusal that
leaves no audit row did not come from here. Run by hand in the container, codex says what it is:

```
approval: never
sandbox:  read-only
```

Codex ships its own sandbox and, with no `config.toml`, starts read-only with approvals off. Every
write failed **inside the engine**, before ACP, so LightsOut was never asked and had nothing to
record. The agent's honest report of its own failure was indistinguishable from a policy denial,
and two rounds of investigation went into a component that was working correctly. §7.1e came out
of that detour: real, worth having, and **not** the cause.

The rule this establishes: **two sandboxes is one too many.** LightsOut mediates every action and
the container is the boundary; an engine confinement nobody configured is a second veto that no
surface displays and no audit row explains. `ensureCodexConfig()` runs at boot (§11.1 step 4a) and
writes, when the file is absent or is an out-of-date copy of its own:

```toml
# managed by LightsOut (ST-09)
sandbox_mode = "danger-full-access"
```

**`workspace-write` was tried first and is wrong here, for a reason worth recording.** It looked
like the careful choice: the engine would still refuse to write outside its working directory,
defence in depth behind PE-02. What it actually does is make the engine *start* its sandbox — and
that sandbox is bubblewrap, which needs unprivileged user namespaces. A Docker Desktop container
does not grant them. The engine then fails with *"the sandbox cannot start because unprivileged
namespaces are unavailable"*, the agent reports a denied write, and we are back where we started
with a different error string. The middle option is the one that cannot work.

So the name of the setting is alarming and the reasoning is not: `danger-full-access` means
"full access **to the container**", and the container holds one workspace and nothing else
(RT-01). Everything the engine does inside it is still announced over ACP, still classified, still
gated by the policy engine, still audited (PE-04) — the confinement is ours, where it is visible.
An engine sandbox we cannot configure, cannot see and cannot audit is not defence in depth; it is
a second veto that produced four hours of debugging and one deleted project.

A `config.toml` without the managed marker belongs to a person and is **never** overwritten. Boot
logs what it found, and warns when the file confines the engine below what LightsOut expects, so
the next hour is not spent in the classifier again.

### 7.1f `process.env` is not `.env`

The fifth spelling, and the widest of them. The doubt the user was shown:

```
timeout 180 node .lightsout/tmp/probe.js 2>&1
  → credentials: script .lightsout/tmp/probe.js reads or carries credentials (.env)
```

The script opens no such file. It reads `process.env.LO_VAULT_EFEMIS_USUARIO`, and the pattern
was `\.env\b` — where `\b` sits happily between the `v` of `process.env` and the dot after it.

**Every Node script that read an environment variable was a credential read.** On the hard floor:
no judge, no learned allow, no grant. Reading `process.env` is how a program uses the vault the
system handed it (§7.1d) — the normal case, matched as the dangerous one, in the single place
where being wrong costs the whole run.

A file name is not preceded by an identifier character and not followed by one:

```
(?<![A-Za-z0-9_])\.env(?:\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_.])
```

`.env` and `.env.local` match; `process.env.X` and `os.environ` do not. Used in both places the
old pattern lived: the script-body families, and the reading-tools matcher where `cat .env` is
caught.

**And the ownership question is now asked of the body too.** PE-13 gave `credentials` an
`evidence` field so the judge could rescue a run's own vault entry, but only on the command-line
path — `classifyScript()` returned a bare `credentials`, so a secret detected inside code could
never be rescued. That is the same gap one layer down, and it is why the fourth and fifth
spellings both got through after PE-13 was supposedly the general fix.

What still stops, and should: `console.log(process.env.LO_VAULT_EFEMIS_PASSWORD)`. Owning the key
does not make printing it safe — the value lands in the transcript — so the subtractive test does
not clear it, and it stays a person's decision. Verified against the deployed classifier by
`scripts/verify-dotenv-7-1f.mjs`, 6/6: the doubt's own command is `network → allow`, while
printing the secret, reading `.env` from code, and `cat .env` are all still `credentials`.

### 7.7 Unattended mode (OR-12)

LightsOut exists to run agents **unattended**. A permission gate that parks a session until a
person looks is, in that light, not a safety feature but a failure of the product: the work stops,
nothing says so, and the cost is paid in wall-clock time nobody is watching. Every incident in
STATE.md is a variation of it.

A project carries `unattended` (`projects.unattended`, default from `lightsout.yaml`), and a launch
may set or clear it for one run. When it is on and a verdict comes back `require_human`:

```
require_human
  │
  ├─ on the hard floor of PE-03?  ── yes ──▶ doubt, as always. This is the whole limit.
  │                                          (outside_workspace, publish_external, force push,
  │                                           credentials that are not vault_own)
  ├─ a hard_rule doubt (KB-11)?   ── yes ──▶ doubt. Only a person answers a binding rule.
  │
  └─ otherwise
       ├─ judge (§7.4, full remit here: other, delete, deps_install, network, toolchain_install,
       │         and vault_own credentials) ── allow ──▶ provisional decision + checkpoint, run continues
       ├─ advisor (§8.2), for what the judge escalates  ── allow ──▶ provisional decision, run continues
       └─ neither clears it ──▶ **refuse, with the reason injected into the run**
```

The last arrow is the one that matters and it is deliberate. **A denial is an answer** (§7.2): the
agent is told what was refused and why, and adapts, narrows scope or routes around it — which is
what it already does well, as the `codex` run that hit `deny (project_write)` on an absolute path
and switched to relative paths without being asked demonstrates. What it must not do is sit there.
An unattended run that could not do one thing and reported that in its deliverable is worth more
than one that stopped and waited nine minutes for somebody to say yes to `grep`.

What is recorded, so that "unattended" never means "unaccountable": every automatic resolution
writes a `provisional` decision (PE-06) naming the decider (`judge` | `advisor`) and its reason, a
`perm.verdict` event with `unattended: true`, an audit row, and a git checkpoint tag. The project
view lists them under **Decided without you** so a person can read afterwards what they would have
been asked, and revoke it. `MAX_AUTO_CONTINUE` per task still caps the advisor path, so an agent
and an advisor cannot agree in a loop; exceeding it falls through to the refusal arm, not to a
doubt.

Not changed by this mode: a **functional** doubt, where the agent asks what to build rather than
whether it may act, is still a doubt and still reaches the person. Unattended decides who answers a
permission gate. It does not decide what the user wanted.

### 7.5 What a task needs, checked before it starts (PE-12)

The other half of the same afternoon: a task that had to call an API, install `openpyxl` and write
an `.xlsx` was launched on `builder`, whose pack denies the network. The agent worked that out
twenty minutes in, and explained it well — but the mismatch was knowable at launch and nobody
looked.

A launch may now declare `needs: ["network", "deps_install", "write"]`. The declaration is checked
against the project pack, the agent's pack and `default`, in that order, and:

- a capability the packs `allow` (or make `provisional`) is granted;
- `require_human` does **not** count — a run that stops in the middle is the thing being avoided;
- anything missing is a refusal, in one second, naming what is missing, which builtin's pack
  already grants it, and the exact `grants: […]` to pass instead.

`grants` widen the policy for **one run**: they become a `grant:` pack, the most specific layer
ahead of the project override, recorded on the task in `tasks.grants` (migration 7) and visible in
the panel. They cannot reach the hard floor of PE-03: `outside_workspace` still never allows, and
`credentials` and `publish_external` still never fall below a human.

**And VT-07**: when a run resolves a vault entry that declares a `base_url`, the run is granted the
network and the host is recorded (`config.changed {kind:'grant', op:'vault', hosts:[…]}`). Handing
an agent a token for an API and then denying the call was the contradiction that made
`contract-prober` the only profile able to do integration work. Per-host enforcement is the egress
allowlist of RT-05 when the proxy is enabled; with it disabled the grant is the whole network, and
this section says so rather than implying otherwise.

### 7.1c A path is a path on *this* filesystem, and nothing else

Running the user's own goal end to end — "download the crops of company 42 from EFEMIS and save
them to Excel" — found three more, and all three were the same mistake in different clothes: text
that looks like a path is not a path.

| in the command | was | why it was wrong |
|---|---|---|
| `# GET /plantation (alternative to /query)` in a heredoc | `outside_workspace`, denied | an API route in a *comment*. Under the hard floor, so nothing could rescue it — and it denied **every script that talks to an HTTP API** |
| `cat doc/PLAN.md 2>/dev/null` | `outside_workspace`, then `project_write` | `/dev/null` is in half the commands ever written, and a redirect to it is not a write |
| `BASE + '/plantation/query'` in a script body | `outside_workspace`, denied | the same thing one layer down, in the body scan |

`looksLikeFilesystemPath()` is now the single answer: a path counts when it starts with a real root
(`/etc`, `/usr`, `/var`, `/home`, `/workspace`, …), when it is a `../` traversal, or when it is
relative and therefore resolved against the project. `/plantation/query` is none of those.
`/dev/null` and its siblings are exempt by name, and `2>/dev/null` is stripped before matching so a
quiet read stays a read. URLs are removed from a script body before it is scanned at all.

**What this cost, and what it bought.** Before: the task could not finish, and the walls arrived one
at a time over several runs. After, on a fresh project with one launch and **no doubts at all**: the
agent installed `openpyxl` into the scratch space, probed the live API, wrote
`scripts/descargar_cultivos.py`, ran it against production (`POST /user/authorization`, then
`POST /plantation/query` with `Company: 42`, count 169), and wrote `output/cultivos_42.xlsx` —
header plus 169 rows, 76 columns — then read it back to check it. Three minutes.

### 7.4 What the classifier does not know, and how it stops asking twice (PE-10)

**The failure.** A chain stopped for eleven minutes on this:

```
R=…/src/efemis_django-master; find $R/throttling $R/user -maxdepth 1 -name '*.py' | xargs wc -l
```

Counting lines. Two blind spots put it in `other`, and `other` is a human gate: nothing knew what
`xargs` was, and a bare `R=/path` assignment matched nothing either — so a pipeline of reads was an
unmatched command. `wc -l src/a.py` on its own was always `project_read`.

**Both are fixed at the source.** Process wrappers (`xargs`, `time`, `nice`, `nohup`, `env`,
`timeout`, `stdbuf`, `command`, `ionice`, `setsid`) are *stripped* with their own flags before
matching, which is safer than listing them as read-only: `xargs rm` is then classified by `rm`. A
segment that only sets a variable changes nothing and counts as read-only. The read-only table also
grew the rest of a normal pipeline (`comm`, `join`, `paste`, `tr`, `rev`, `seq`, `ps`, `env`, …).

**And the general case: the system learns.** Fixing the table only covers what is already known.
When a human answers a permission gate with "allow" and the class was `other`, the *shape* of the
command is remembered, and the same shape is allowed without a gate from then on:

```
commandShape("find /a/b -maxdepth 1 -name '*.py' | xargs wc -l")
  → "find <path> -maxdepth <n> -name <str> | xargs wc -l"
```

Paths, quoted strings and numbers become placeholders; the programs, their flags and the pipeline
survive. So the same *kind* of command passes and a different one still asks.

| decision | why |
|---|---|
| every class is learnable except two | a person who read the command and said yes must not be asked again. `credentials` and `publish_external` are the exception: a wrong memory there leaks a secret or publishes something, and neither can be taken back. `outside_workspace` cannot be allowed at all |
| a doubt says when the same shape was answered before (DO-07) | in those two classes the question *will* come back by design; naming the earlier answer turns a decision into a confirmation. It was the second identical question — D-1 allowed, D-2 asked again nine minutes later — that showed learning only `other` was too narrow |
| the hard floor is untouched | PE-03 is not consulted differently: `other` was never on it |
| shapes are system-wide | the user asked for it: a shape allowed once is allowed everywhere, because the same person owns every project here |
| every use is counted | an unused rule is easy to revoke, and a much-used one is a matcher somebody should write into a pack |
| revocable from both surfaces | `list_learned_allows`, `forget_learned_allow`, `DELETE /api/learned/:shape` |

Storage is migration 6: `learned_allows(shape UNIQUE, sample, action_class, learned_from, added_by,
uses, last_used_at)`, plus `doubts.action_class` and `doubts.action_shape` so an answer knows what
it is teaching. The verdict says so in its reason, and the audit row records `learned: <shape>`.

### 7.6 A development environment that survives the run (ST-07, ST-08)

Until now a project needing a tool the image does not ship had two answers, and both were bad.
`pip install --target .lightsout/tmp/deps` works and is swept when the run ends (PE-08), so the
next run installs it again — fine for one library, useless for a framework. And a real install
into the image is `deps_install`, which asks a human every time and cannot be remembered, because
ST-03's reason for the gate is exactly that a dependency outlives the run.

The missing thing was a place that outlives the run *and* is still not the image.

**`/toolchains`, a managed volume, one directory per project.** Created at scaffold, mounted in
compose, and put on the run's environment by `runContext`:

```
PATH            <project-toolchain>/bin:<project-toolchain>/node_modules/.bin:$PATH
NODE_PATH       <project-toolchain>/node_modules
PYTHONPATH      <project-toolchain>/py:<project>/.lightsout/tmp/deps
npm_config_prefix  <project-toolchain>
```

A volume rather than a directory in the workspace: it is build output, it is large, it is not
something a person should find next to their source, and RT-02 exists so the workspace is *theirs*.
`resolve_path` reports it as a container path with no host equivalent, honestly, rather than
inventing one.

**A new capability and a new action class, `toolchain_install`.** An install whose target resolves
inside the project's toolchain directory classifies `toolchain_install`; the same command anywhere
else is still `deps_install`. Every pack defaults it to `require_human` — including the packs that
allow `deps_install`, because this one is durable and that one is not.

**The authorisation is per project and per manager, and it is remembered.** Answering the doubt
"allow" records a grant `(project, manager)` — `npm`, `pip`, `pnpm`, `uv`, `cargo`, `go` — and the
same project never asks for that manager again. Deliberately *not* PE-10's system-wide learned
shapes: a shape is a command, and this is a standing power over a durable directory of one project.
`list_toolchain_grants` / `revoke_toolchain_grant` and a card in the panel; migration 9 stores
`toolchain_grants(project_id, manager, granted_by, created_at, uses, last_used_at)`.

What it still cannot do: write outside its own toolchain directory (the hard floor of PE-03 is
unchanged), install a *package manager* (ST-03b — the image ships those), or touch another
project's toolchain.

**What needs root: asked, never done here (ST-08).** `apt`, and anything writing into the system
prefix, is out of reach by construction and must not look like a permission problem. An agent that
needs one raises `doubt.toolchain` with the machine-first request:

```
manager: apt
package: libpq-dev
reason: psycopg2 needs the postgres client headers to build
alternative: none found in user space
```

That doubt behaves like `hard_rule`: **never sees the advisor, never auto-continues, never spends
the auto-continue budget.** On approval LightsOut appends the line to
`workspace/toolchain.d/<project>.txt` — read by the Dockerfile at build time — and answers with the
exact command for the user's own terminal. The build is theirs to run: a container that can
rebuild its own image is a container that can replace itself with a different one.

**Rejected, and recorded in DECISIONS: mounting the Docker socket, or Docker-in-Docker.** It would
make all of this automatic and it would hand an unattended agent the host — every other boundary in
this document is decoration once the daemon is reachable. The cost of the alternative is one
command the user runs themselves, occasionally.

## 8. Doubts and second opinion (DO-01..06)

### 8.1 Sources

(a) Result sentinel with `status:"doubt"` (§6.4) — kind `functional`, session has ended its turn.
(b) Permission verdict `require_human` (§6.5) — kind `permission`, session held open.

### 8.2 Advisor consultation (DO-02, SR-08)

Before opening any doubt whose action class is reversible:

```
advisor = the OTHER engine, ephemeral session, cwd = project.path,
          policy pack 'advisor' (everything read-only, terminal deny)
prompt  = context + options + "Answer ONLY with JSON:
          {\"choice\":\"A|B|…\",\"confidence\":0..1,\"rationale\":\"≤80 words\"}"
```

A permission doubt has no recommendation from the agent that raised it — the gate exists because the policy had no answer, not because someone proposed one. It is nevertheless given a **derived recommendation** of "allow" when its action class is reversible and is not `deps_install`, so the advisor can settle it like any other doubt. `deps_install` is excluded on purpose: a dependency changes the lockfile and the build environment for every later run (ST-03), which is a human call even when it is technically reversible. Because an allow derived this way was proposed by nobody, it is held to a stricter bar: `max(LO_ADVISOR_CONFIDENCE, 0.8)`. Everything else about the flow is unchanged — checkpoint tag, `provisional` decision row, and the `MAX_AUTO_CONTINUE` cap per task.

Decision rule: `advisor.choice == doubt.recommendation && advisor.confidence >= LO_ADVISOR_CONFIDENCE` → **auto-continue**: decision row (`kind='provisional'`), git checkpoint tag `lightsout/cp/<taskId>-<n>`, DECISIONS.md entry, then resume (functional: `session/prompt` continuation or new run with the decision prepended; permission: respond allow). Otherwise → open the doubt, attaching `second_opinion` so the human sees both positions (DO-03). Advisor failure/timeout (60 s) → open the doubt (fail toward the human, never toward silence). Irreversible classes skip the advisor entirely.

### 8.3 Doubt persistence and mirroring (DO-01)

Insert `doubts` row → append to project `QUESTIONS.md`:

```
@DOUBT-OPEN
### D-7 — Incremental or full sync on reconnect?
- Created: 2026-07-24T14:21Z   - Blocks: task 3 (sync engine)
- Options: A) incremental by timestamp  B) full dump
- Recommendation: A
- Second opinion: codex → A (0.86)
- Answer: (pending)
```

DB is the source of truth; the MD mirror is regenerated from the DB on every doubt transition (never parsed back).

### 8.4 Answering (DO-04)

`answer_doubt(id, choice, note?)` → validate open → decision row (`kind='human'`) → DECISIONS.md → QUESTIONS.md marker `@DOUBT-CLOSED` → resume: permission doubts respond to the held ACP request (allow if the choice authorizes, deny otherwise, with the note injected as a user turn); functional doubts resume the session (`session/load` when the adapter supports it, else new run with full context + the decision). Permission wait expiry (`LO_PERMISSION_WAIT_HOURS`) cancels the run as `interrupted` with resume info; the doubt stays open.

## 9. Projects, docs and git (PM-01..06)

### 9.1 Per-project config `lightsout.yaml`

```yaml
name: Consultant Portal
verify: "npm test && npm run lint"     # OR-04; empty = no gate
push: manual                            # auto | manual | never (PM-05)
policy:                                 # optional override pack (PE-05)
  rules: [ { class: deps_install, verdict: allow } ]
remote: git@gitlab.example.com:group/consultant-portal.git
```

### 9.1b The project context brief (PM-09)

Every project carries a `context` column: a short prompt, asked for at creation **whatever the
template**, saying what the project is for. Without it the first agent starts from a phase title and
whatever it can infer — which is how a phase ends up interrogating the empty set, and the whole
reason `launch_phase` grew an `input` parameter (§15). The brief is the shared, durable answer;
`input` stays what someone is asking for *on this run*.

- **Required and non-empty at creation.** `createProject` refuses an empty brief. Nothing else about
  its shape is enforced — the user asked for a low bar — but the panel's form names what is worth
  stating: goal, actors, systems involved, constraints, definition of done, what is out of scope.
- **Injected into every prompt**, as block 4b of §6.2, under a heading that says it is fixed
  context for the project rather than the task.
- **Editable from both surfaces** (`set_project_context`, `POST /api/projects/:id/context`), because
  a brief written before the work started is the one thing most likely to need a correction.
- **Migration 4 backfills existing projects** with a factual placeholder marked
  `status: provisional` — the project's name, its template and a line saying the brief is pending.
  It does not block them from running and it does not pretend to be a brief; the panel shows an
  amber "provisional context" badge until someone writes one.

### 9.2 Managed doc sections (PM-02)

`STATE.md` mixes free text with a machine-owned block, regenerated at every task close from the DB.
Machine-first since BA-07 (§20):

```
<!-- lightsout:begin -->
state.updated: 2026-07-26T09:12:03Z
chain.title: Offline sync
chain.status: active
chain.progress: 4/6
task.last_ok: Tests green
task.next: sync status screen
decision.last: incremental sync
decision.kind: human
decision.at: 2026-07-24
doubts.open: none
<!-- lightsout:end -->
```

Everything outside the markers is never touched. `PLAN.md` uses one checkbox line per task with the task id in a trailing tag (`- [x] Wire repository  <!-- lo:t_01H… -->`); the orchestrator flips checkboxes by id. DECISIONS.md and QUESTIONS.md are append-only (§8.3).

### 9.2b Writing a document without destroying it (MC-12, MC-13, MC-14)

**The failure this fixes.** A client called `write_doc` on `DECISIONS.md` to add one entry. The tool
does what its name says — it replaces the file — and eight recorded decisions stopped existing. No
run was active, so nothing refused it; no commit had been made since they were written, so git had
nothing to give back. The tool behaved as designed and the design was wrong: the only writing verb
was the destructive one, and it could be used by a caller who had never read the file.

Four changes, none of which trust the caller to be careful.

**A snapshot before every overwrite.** `write_doc` and `patch_doc` copy the current file to
`.lightsout/doc-history/<DOC>-<ts>.md` before writing, keeping the last ten. `.lightsout/` is already
git-ignored and already swept for scratch (PE-08), and the history directory is exempt from that
sweep. This is not version control and does not try to be: it is the ten seconds of regret that git
cannot cover, because doc writes happen between commits.

**`append_doc`, and a refusal.** `DECISIONS.md` and `QUESTIONS.md` are append-only by design (§8.3)
and were append-only by convention only. `append_doc {projectId, doc, content}` adds to the end with
one blank line of separation; `write_doc` on either of those two now refuses, naming `append_doc`.
A document the system also writes from the database is not a document a client may replace wholesale.

**`patch_doc`, because a 1500-line STATE.md is not worth resending.** `patch_doc {projectId, doc,
edits:[{find, replace, expectCount?}]}` applies exact-string edits, all or nothing: a `find` that
matches zero times is an error, a `find` that matches more than once is an error unless
`expectCount` says so, and no edit is written unless every edit resolved. Ambiguity is refused
rather than guessed at, for the same reason the policy engine refuses an unreadable script body.

**Optimistic concurrency on `write_doc`.** The optional `baseHash` is the sha256 of the content the
caller read. When it is given and does not match, the write is refused with `CONFLICT` and the
current hash, which is the machine-checkable form of "you are about to overwrite something you have
not seen". Optional now because the panel and existing clients predate it; the intent is that the
docs the system also writes eventually require it.

The same snapshot applies to `write_knowledge_doc`, under
`$LIGHTSOUT_WORKSPACE/.lightsout/knowledge-history/<baseId>/`, and deliberately *not* inside the
base's own folder: a linked base points at a folder that belongs to the user, and LightsOut does not
leave litter in it (KB-08).

### 9.3 Git strategy (PM-04, PM-05)

- `create_project`: `git init` if needed, `.lightsout/tmp/` created with a `.gitignore` that ignores
  the whole `.lightsout/` directory (PE-08), then the initial commit of the scaffold.
- During a run: wip commit every 10 min if dirty and at run end — `wip(lightsout): <taskId> <ts>`.
- Task ok: consolidated commit `feat: <task title> [lo:<taskId>]` (wips remain in history; squashing is v2).
- Provisional decision: annotated tag `lightsout/cp/<taskId>-<n>` at the pre-decision commit (the v2 rewind target).
- Push: orchestrator-only (`git_push` is `deny` for agents), `push_policy=auto` requires verify green in the same task cycle; `--force` is not implemented at all. Credentials: mounted ssh key or `GIT_TOKEN` via credential helper; never persisted (NF-02).

### 9.4 Reading the project's documents (PM-10)

The deliverables are the product of a run, and until now the only way to read one was the
filesystem: `read_doc` knew four managed names and nothing else, so `ANALYSIS.md`, `AUDIT.md` and
`OPEN-QUESTIONS.md` were invisible to both surfaces.

`listDocs(projectId)` walks the project for `*.md`, skipping `sources/`, `.git`, `node_modules` and
`.lightsout`, bounded at 6 levels and 300 files, and returns for each one: the project-relative path,
`bytes`, `modified`, whether it is one of the managed docs, and the BA-08 verdict (`ok`, `exempt`,
`reasons`) so drift is visible in the list rather than only in an event.

`readProjectDoc(projectId, relPath)` returns the content of one of them. Confinement is the whole
security model here and it is checked, not assumed: the path is resolved against the project
directory and refused if it escapes, if it is absolute, if it is not `.md`, or if it lands in one of
the excluded directories. Content is returned whole up to 400 KB, then truncated with
`truncated: true` — a viewer that silently shows half a document would be worse than one that says so.

Both answers carry two paths: `path` (inside the container, `/workspace/…`) and `hostPath` (the same
file on the user's own machine, from `LO_WORKSPACE_HOST`), because MCP's caller is a person who may
want to open the file in their editor and the container path is useless to them. When the host
workspace is not configured, `hostPath` is null rather than a guess.

**Everywhere, not only here (MC-08).** `health` reports the workspace both ways, `project_status`
carries the project's `hostPath`, areas carry theirs, and `resolve_path` translates one path into
the other in either direction — give it a container path, a host path or a project-relative one and
it answers with all three plus whether the thing exists. A Windows host path is answered with
backslashes even when the mount was written with forward slashes, because its whole purpose is to
be pasted somewhere.

### 9.5 Read-only workspace areas (PE-09)

**The failure this fixes.** A curation project was told, by the user, exactly where the code was:
`/workspace/sources/efemis_django-master`. Every attempt to reach it — `ls -la /workspace/sources/`,
`cp -r … ./sources/`, even `ls /workspace/`— classified as `outside_workspace` and was denied by the
hard floor. The agent could not read it, could not copy it, and spent six passes writing a document
about being blocked. The policy was right in the general case and wrong in this one, and there was
no way to say so.

An **area** is that missing sentence: *this project may read this directory of the workspace.*

```
migration 5: project_areas(id, project_id, path, note, added_by, created_at)
             UNIQUE (project_id, path)
```

`path` is workspace-relative and stored normalised with forward slashes. Rules, all enforced in
`validateArea()` and none of them overridable by a pack:

| refused | why |
|---|---|
| the workspace root, or anything above it | an area is a *part* of the workspace, not all of it |
| `agents/`, `templates/`, `vault.yaml` | an agent may not read the system that runs it (§7.1) |
| anything under `knowledge/` | KB-03/KB-05 govern knowledge; attach a base instead |
| another project's directory under `projects/` | one project is not a source of truth for another |
| a path that does not exist | a typo is refused at declaration, not silently at run time |

**Read, or write — declared, and defaulting to read (migration 12).** The original design said
read only, always, and gave a reason that is still half true: making *every* area writable would
put one project's agent inside another project's files. But the conclusion drawn from it was too
wide. The user's case is a shared output directory — somewhere a project puts what it produces so
the next one can pick it up — and refusing that does not make the workspace safer; it makes people
put the folder inside the project and copy it out by hand.

So `project_areas.access` is `read` or `write`, and the difference the classifier makes is small
and exact:

| where | reading | writing |
|---|---|---|
| a `read` area | `project_read` | `outside_workspace` — denied by the hard floor, as before |
| a `write` area | `project_read` | `project_write`, decided by the pack like any other write |

**What may never be an area at all did not change, and is what makes this safe.** The refusal
table above is checked in `validateArea()` before access is looked at, and the two absolute
prohibitions — `agents/`, `templates/`, `vault.yaml` → `credentials`; another project → refused —
are enforced *again* in `classifyEscape()` ahead of the area loop. A row cannot widen them however
it was written, which is the property worth having when a new column can now say "write".

Existing rows keep `read`: widening a boundary already granted, by migration, would be the system
making a decision that belongs to a person. Declaring the same path again is how access changes,
and it records a `config.changed` event either way — narrowing is a decision too.

The runner resolves the project's areas before the session starts and passes them to the classifier
with the workspace root; the prompt lists them under the project context, because an area the agent
does not know about is an area it will not use. Every declaration and removal is a
`config.changed {kind:'area'}` event with the actor: a widened boundary is a decision, and it is
recorded like one.

### 9.6 A project has a layout, and the protocol says so (PM-11, MC-11)

**The failure.** A run asked for an HTML prototype finished `ok`, committed 2261 lines, and the
user pressed Preview and got nothing. The page was real and good — 1912 lines — and it was at
`doc/efemis_prototipo.html`. `detectPreview()` looks where code goes; the agent had put it where
documents go; nobody had ever said which was which.

Three complaints arrived together — *"why can't I preview, it is an HTML"*, *"shouldn't generated
code be in something like src/"*, *"why not a master prompt that explains the basics"* — and they
are one defect. The third is the fix for the first two.

**The layout, scaffolded and stated:**

| directory | what belongs there |
|---|---|
| `src/` | the code that is the deliverable. A single page is `src/index.html`. |
| `doc/` | documents the system reads back (BA-07), never code |
| `probes/` | throwaway scripts proving something about an external system |
| `sources/` | material imported from elsewhere, e.g. an unpacked archive |
| `output/` | generated artefacts that are not code — a spreadsheet, a report |
| `.lightsout/tmp/` | scratch, emptied at the end of every run (PE-08) |

`src/index.html` is not a preference: it is what makes Preview work with nobody typing a filename
(PV-07). A brief that names a different layout wins — an imported codebase has its own, and
`legacy-intake` puts it in `sources/` on purpose. What is not acceptable is each run guessing.

**The protocol block is where this is said (MC-11).** It already existed at v4, prepended to every
prompt, and covered permissions, the scratch directory, `pip install --target` and the machine-first
format. It said nothing about where files go, nothing about credentials, and nothing about
`preview_start`. So the block gained three sections and became **v5**:

- **where things go** — the table above, in six lines.
- **credentials** — read from the environment at the point of use; never print one, never write one
  to a file, never search the tree for one. This is worth stating because every credential gate this
  system has opened by mistake came from an agent *inventing* its own handling: a `grep -rqF
  "$LO_VAULT_…"` leak check (§7.1d), a `[ -n "$X" ]` wiring probe (§7.1b), a `console.log` of an
  environment variable. Told what safe looks like, an agent does not reach for the shapes the
  policy exists to stop.
- **showing your work** — `preview_start` publishes a URL and outlives the run; a server started in
  the terminal never returns and is denied for that reason (PV-02). Saying it here means the agent
  learns it before the refusal rather than from it.

The general rule this settles: a behaviour every agent must have belongs in the protocol block,
where it is stated once and versioned, not in thirteen profiles where it drifts.

## 10. MCP server (MC-01..06)

### 10.0 A server that teaches its own use (MC-09)

The client of this MCP server is a model with no memory of this repository. Until now it could
*call* forty-five tools and had no way to learn what a phase is, why a template is not an agent, or
that a knowledge base is attached rather than pasted. The documentation lived in `doc/` — where the
client cannot see it — so the system was usable only by someone who had already read it.

Two layers, both over MCP and nothing else:

1. **Server instructions** (`src/mcp/server.ts`), short and always in the client's context: what
   LightsOut is, the four nouns (project, phase, chain, agent), the handful of rules that are
   expensive to get wrong (every launch states its request and its expected return; a doubt is a
   decision, not an error; the workspace is the user's own folder; a project without a template is
   the exception and says why, §16.4), and one line saying that `guide` has the details.
2. **`guide { topic? }`** — with no topic it lists them; with one it returns that section whole.
   The text lives in `builtin/guide/*.md`, shipped in the image and machine-first like everything
   else the system writes (BA-07): `key: value`, tables, worked examples, no prose. Sections:
   `overview`, `launching`, `agents`, `templates`, `phases`, `knowledge`, `areas`, `vault`,
   `doubts`, `policies`, `documents`, `troubleshooting`.

`health` stays what it is: state. A client that asks health "how do I write a template" gets a
database check, which is the right answer to a different question.

### 10.0b Every launch states its request and its expected return (OR-10)

`launch_task`, `launch_chain` and `launch_phase` all require two fields beyond the target:

- **the request** — what is being asked *this time*, in the caller's words. For a phase this is the
  `input` that was optional and is now not: a phase whose instructions are frozen still needs to
  know which subsystem, which question, which integration.
- **`expects`** — what comes back, in the caller's words: the artefact, its shape, and how anyone
  will know it was met. It is not the same as the phase's `deliverable`, which is a path the system
  checks on disk; `expects` is the *content* contract, and it is the thing a person actually has an
  opinion about.

Both are appended to the task spec under their own headings, so they are durable (the task row),
visible (the panel, `project_status`) and unavoidable (the prompt). A launch missing either is
refused with a message naming what to add. The project brief (PM-09) is the standing context and is
injected separately: brief = what this project is, request + expects = what this run is.

### 10.0c `status_card` (MC-10)

Claude Desktop does not render a live view pushed from an MCP server — UI resources are negotiated
and then ignored, which is a reported defect of the client, not of this design. So the honest
answer to "can I watch the project without opening the panel" is: a snapshot, on demand, compact
enough to read at a glance:

```
LIGHTSOUT :: consultant-portal            2026-07-26T14:02Z
phase      3/6  implement            running   12m
run        01KYF…  builder/claude    tool.call Edit src/api/sync.ts
doubts     D-7 open (permission, 4m)
next       write the sync tests
docs       doc/PLAN.md 4.1kB ok · doc/ANALYSIS.md 19kB ok
paths      C:\Users\…\LightsOut\projects\consultant-portal
```

The live view is the panel at `127.0.0.1:8484`, and the card says so in one line.

### 10.1 Transport

Primary: streamable HTTP at `POST /mcp` on the same Fastify server (protected only by localhost binding, WP-09). For Claude Desktop stdio configs, `dist/mcp/stdio-bridge.js` is a stateless bridge: reads JSON-RPC from stdin, forwards to `http://127.0.0.1:8484/mcp`, streams responses back. Desktop config:

```json
{ "mcpServers": { "lightsout": {
    "command": "docker", "args": ["exec","-i","lightsout","node","dist/mcp/stdio-bridge.js"] } } }
```

Current builds of Claude Desktop ignore that file, so the documented path is the custom-connector
URL or the packed extension (SU-09, §14.3b); the bridge stays for builds that still read it.

The bridge holds no state and no DB handle (single-writer preserved, ST-02).

### 10.2 Tool contracts (MC-02)

Uniform envelope: success `{ok:true, …}`; failure `{ok:false, error:{code,message}}`. Codes: `NOT_FOUND`, `INVALID_INPUT`, `PROJECT_LOCKED`, `AUTH_REQUIRED`, `CONFLICT`, `INTERNAL`. All ids are strings. Fields marked `?` optional.

**Parity with the panel (MC-07).** Every action in `src/control/actions.ts` is reachable from both
surfaces, with one deliberate exception: **the vault**. `list_vault` shows labels, URLs and field
names; there is no tool that writes one. A value written through MCP would travel through the
Desktop conversation to get here, and VT-02 says values reach the adapter's environment and
nowhere else. Vault entries are edited in the panel, on loopback, or not at all.

The exception is the only one. A new action that the panel can call and no tool can is a review
failure, the same way a route that skips `actions.ts` is — the whole point of §12.0 is that the
two surfaces are skins, and a skin that is missing a control is a fork in slow motion.

| tool | input | output (`ok:true` +) | notes |
|---|---|---|---|
| `health` | `{}` | `{db, engines:{claude:{installed,auth},codex:{…}}, network, activeRuns, version}` | RT-06 |
| `list_projects` | `{archived?:bool}` | `{projects:[{id,name,status,activeRun?,openDoubts,lastActivity}]}` | |
| `archive_project` | `{projectId, archived?:bool}` | `{project:{id,archived}}` | reversible; hides it and refuses new launches (PM-08) |
| `delete_project` | `{projectId, confirm, keepFiles?:bool}` | `{deleted:true, filesRemoved:bool}` | irreversible; `confirm` must equal `projectId`, refused while a run is active (PM-08) |
| `create_project` | `{name, context, template, templateReason?, knowledge?:[baseId], writableKnowledge?:baseId, remote?, verify?, push?}` | `{project:{id,path}, phases:[{phaseId,title,agentId,gate}]}` | scaffolds and materialises the phases (PM-01, TP-05); `template` is required and `"none"` is a valid answer that requires `templateReason` (TP-09); `writableKnowledge` is required by the curation template and refused by every other (KB-05) |
| `project_status` | `{projectId}` | `{project:{…,templateId,knowledge:[…]}, phases:[{phaseId,title,agentId,status,deliverable,gate,startedAt,endedAt}], chain?:{id,title,tasks:[…]}, run?:{id,status,engine,model,elapsedS,inactivityS,lastAction,timeoutS}, doubts:[…], state:{phase,lastDecision,next}}` | one call = full picture including what is done, running and pending (MC-06, TP-06) |
| `list_agents` | `{}` | `{agents:[{id,name,engine,model,enabled,source,valid,error?}]}` | AP-02, AP-07, BA-01 |
| `write_agent` | `{agentId, name?, engine?, model?, reasoning?, instructions?, policy?, tags?, deliverable?, advisor?, enabled?}` | `{agent:{…}}` | create or edit; on a builtin it writes the workspace copy that shadows it (AP-06). An unknown model is rejected with the accepted list (AP-08) |
| `set_agent_enabled` | `{agentId, enabled:bool}` | `{agent:{id,enabled}}` | AP-07 |
| `delete_agent` | `{agentId}` | `{revealedBuiltin:bool}` | deletes the workspace copy; a builtin of the same id reappears under it (AP-06) |
| `reload_agents` | `{}` | `{loaded,rejected:[{file,error}]}` | AP-03 |
| `list_templates` | `{}` | `{templates:[{id,name,whenToUse,notFor,description,source,phases:[…],valid,error?}]}` | TP-03. `whenToUse`/`notFor` come first in each entry: the caller is choosing, not reading (TP-10) |
| `write_template` | `{templateId, name?, description?, requiresWritableKnowledge?, phases?:[{id,title,agent,instructions,deliverable?,verify?,gate?,optional?,repeatable?}]}` | `{template:{…}}` | create, clone a builtin, or replace the phase list in order (TP-04) |
| `delete_template` | `{templateId}` | `{revealedBuiltin:bool}` | workspace copies only (TP-04) |
| `list_phases` | `{projectId}` | `{phases:[{phaseId,title,agentId,status,gate,deliverable,optional,repeatable,startedAt,endedAt}]}` | TP-06 |
| `launch_phase` | `{projectId, phaseId?, input?}` | `{phaseId, taskId?, runId?, queued?}` | `phaseId` omitted means the next pending one; `input` is what is being asked for this time (TP-07, §16.2 amendment) |
| `skip_phase` | `{projectId, phaseId}` | `{phase:{…}}` | requires `optional` (TP-07) |
| `add_phase` | `{projectId, title, agentId, instructions, position?, deliverable?, verifyCmd?, gate?}` | `{phase:{…}}` | ad-hoc phase, not in the template (TP-08) |
| `list_knowledge` | `{kind?}` | `{bases:[{id,name,kind,description,tags,updated,source?,docs,attachedTo:[projectId]}]}` | KB-01 |
| `read_knowledge` | `{baseId, path}` | `{content, kind, updated}` | fetches a document the budget left out (KB-06); read-only, no project needed |
| `write_knowledge` | `{baseId, name?, kind?, description?, tags?, owner?, source?:string\|null}` | `{base:{…}}` | create or edit the manifest; `source` links a workspace folder, `null` unlinks (KB-08) |
| `write_knowledge_doc` | `{baseId, file, content}` | `{file}` | text only — `.md`, `.markdown`, `.txt` (KB-08) |
| `delete_knowledge_doc` | `{baseId, file}` | `{deleted:true}` | refused on a linked base: that folder belongs to something else (KB-08) |
| `delete_knowledge` | `{baseId}` | `{deleted:true}` | refused while attached to a project (KB-03); a linked folder is left alone |
| `attach_knowledge` | `{projectId, baseId, detach?:bool, writable?:bool}` | `{baseId, writable}` | `writable` only for a curation project, and never a linked base (KB-03, KB-05, KB-08) |
| `list_vault` | `{}` | `{entries:[{id,label,base_url,auth,test_only,scope,fields:[{name,present,updated}]}]}` | never a value (VT-03). There is no write tool: see the parity note above |
| `launch_chain` | `{projectId, title, tasks:[{title,spec,agentId,level?,verify?}]}` | `{chainId, taskIds, started:bool, queued:bool}` | fire-and-forget (MC-06) |
| `launch_task` | `{projectId, title, spec, agentId, level?, verify?, chainId?}` | `{taskId, runId?, queued}` | appends to chain if given |
| `abort_run` | `{runId?, chainId?}` | `{aborted:[ids]}` | OR-06 |
| `steer_run` | `{projectId?, runId?, note}` | `{runId, noteId, pending, inbox}` | corrects a run in flight without killing it: the note lands in the agent's inbox and anything unread is handed over in a steering turn before the run may finish (SR-09, §6.8) |
| `resume_chain` | `{projectId?, chainId?}` | `{chainId, requeued:[ids], started:bool}` | OR-05. The counterpart to the pause: queues the tasks that did not finish and leaves `ok` ones alone. Never automatic — a chain paused by a container restart or a failed task had no way back before this |
| `list_doubts` | `{projectId?, status?:'open'}` | `{doubts:[{id,ref,projectId,taskTitle,kind,context,blocks,options,recommendation,secondOpinion?,ageMin}]}` | Desktop renders options as buttons (MC-03) |
| `answer_doubt` | `{doubtId, choice, note?}` | `{resumed:bool, runId?}` | DO-04; `doubtId` accepts the ulid or the `ref` (`D-3`) when `projectId` context is unambiguous |
| `get_history` | `{projectId?, limit?:20, before?}` | `{runs:[{id,task,engine,model,status,startedAt,durationS,costUsd?,summary}], totals:{byStatus,costUsd}}` | OB-05 |
| `read_doc` | `{projectId, doc:'STATE'\|'PLAN'\|'DECISIONS'\|'QUESTIONS'}` | `{content, hash, updatedAt}` | `hash` is what `write_doc.baseHash` expects back (MC-14) |
| `write_doc` | `{projectId, doc, content, baseHash?}` | `{written:true, hash, snapshot?}` | replaces the file. Rejected if a run is active (`CONFLICT`), if `doc` is append-only, or if `baseHash` does not match; scoped to doc/ (MC-04, MC-12, MC-14) |
| `append_doc` | `{projectId, doc, content}` | `{written:true, hash}` | adds to the end. The only writing verb allowed on DECISIONS and QUESTIONS (MC-13, §8.3) |
| `patch_doc` | `{projectId, doc, edits:[{find,replace,expectCount?}]}` | `{written:true, hash, applied, snapshot?}` | exact-string edits, all or nothing; zero or ambiguous matches are refused (MC-13) |
| `consult` | `{projectId?, engine?, question}` | `{answer, engine, model, durationS}` | on-demand advisor (MC-05/DO-06) |

Behavioral notes: `launch_*` returns within ~1 s (run starts async); `project_status` is the polling primitive Desktop uses after launches; every mutating tool emits events so the panel updates in real time without extra wiring.

## 11. Boot, recovery and health (RT-04, RT-06, RT-07)

### 11.1 Boot sequence (`src/index.ts`)

1. Parse config (abort on invalid). 2. Open DB, run migrations. 3. Recovery pass (§11.2). 4. Ensure the workspace layout exists (`agents/`, `agents/policies/`, `templates/`, `knowledge/`, `projects/`, a workspace `.gitignore` covering `vault.yaml`), then load agent profiles, policy packs, templates and knowledge manifests — `builtin/` first, workspace shadowing on top (§2). Nothing is copied into the workspace: the builtins are usable where they are (BA-01). 5. Engine detection: adapters present on PATH + auth probe per engine (cheap CLI status command; result cached 10 min, re-probed on failure). 6. Start HTTP (panel/API/SSE/health/mcp). 7. Rebuild project locks (empty) and resume nothing automatically — interrupted work is surfaced, not silently retried.

### 11.2 Recovery pass

`UPDATE runs SET status='interrupted', exit_reason='container restart' WHERE status IN ('running','waiting_human')` + matching task/chain updates + one `system` event each, including the stored `acp_session` for manual resume. Doubts stay open across restarts (they live in the DB). "Manual resume" is `resume_chain` / `POST /api/projects/:id/resume` (§10.2): without it the recovery pass is a dead end, leaving tasks `interrupted` and no action able to move them.

### 11.2b Failure containment

Nothing a single run does may end the process, because the process is every other project's chain too. Three layers, outermost last:

- **The runner** wraps `session.start()`. Whatever escapes becomes an `error` outcome and travels the ordinary failure path — run finished, task failed, chain paused, reason on the timeline — so a dead adapter costs one run.
- **The chain loop** catches around `runTask` (which also does git, the verify gate and the managed docs) and around `drive` itself. `drive` is started and not awaited, so an uncaught rejection there has nowhere to go: that catch is what stands between a library rejecting a promise and a process exit.
- **`index.ts`** registers `unhandledRejection` and `uncaughtException` handlers that log the stack, record a `system` event and **do not exit**. Node's default is to kill the process, which for an unattended orchestrator is the worst available response. This is a safety net, not a licence: every rejection it catches is a bug to fix where it happens.

This is written down because the alternative was observed — an `EPIPE` on an adapter became `Error: ACP connection closed`, rejected the driver promise nobody had a `catch` on, killed the container, and left the user with a chain paused and no stated reason.

### 11.3 Auth expiry mid-run

Adapter auth errors are recognized by the ACP error surface → run `error` with `exit_reason='AUTH_REQUIRED'`, engine health flips to `auth:false`, panel shows it in the attention strip (OB-03), `health` tool reports it, and the fix is reconnecting the engine from the panel (§14.4), with `scripts/login-*.sh` as the fallback (RT-04).

## 12. HTTP API, SSE and panel (WP-01..11)

### 12.0 One entry point, two surfaces (WP-02, MC-01, SU-05)

The panel and the MCP tools are two skins over the same functions. `src/control/actions.ts`
exports every operation that changes anything — `createProject`, `launchPhase`, `skipPhase`,
`abortRun`, `answerDoubt`, `writeAgent`, `writeTemplate`, `attachKnowledge`, `writeVaultEntry`,
`writeDoc`, `archiveProject`, `deleteProject` — each taking an explicit `actor: 'mcp' | 'panel'`
as its first argument. An MCP tool
module and an HTTP route handler are both a dozen lines: validate input with zod, call the
action, shape the response.

That is what keeps the SU-05 promise honest now that the panel can do everything: there is no
second implementation to drift, no route that reaches into a repo directly, and every mutation
lands in `events` with its actor. A route handler that touches SQLite outside an action is a
review failure.

### 12.1 Read-only JSON endpoints

```
GET /health                          → same shape as the MCP health tool
GET /api/overview                    → projects summary + active runs + open doubts + engine health
GET /api/projects/:id                → same shape as project_status
GET /api/projects/:id/history?limit&before
GET /api/runs/:id/events?after=<id>  → paginated event timeline
GET /api/projects                    → the project list of WP-10: template, phase counts, current phase, doubts, last activity
GET /api/projects/:id/phases         → the phase list with status, agent, deliverable, run (TP-06)
GET /api/agents                      → profiles with source ('builtin'|'workspace'), enabled, validation errors
GET /api/agents/models               → accepted model and reasoning values per engine (AP-08)
GET /api/templates                   → templates with source, phases, validation errors
GET /api/knowledge                   → knowledge bases: manifest, document count, size
GET /api/knowledge/:baseId/doc?path= → one knowledge document, read-only
GET /api/vault                       → entry labels, base URLs, field names, presence and dates — never values (VT-03)
```

All handlers are SELECT-only against SQLite, or read-only against the workspace for the
config resources (OB-01 still holds for everything operational).

### 12.1b Mutating routes (WP-02, SU-05)

Every route below is a thin call into `src/control/actions.ts` with `actor='panel'` (§12.0),
localhost-bound, and enumerated here and nowhere else.

```
# Setup and export
POST   /api/setup/workspace          → set or confirm the host workspace path (RT-02)
POST   /api/setup/login/:engine      → start the interactive login, returns {flowId}
GET    /api/setup/login/:flowId      → SSE: url, code, progress, final auth state
POST   /api/setup/login/:engine/key  → store an API key through the engine CLI (NF-03)
POST   /api/export/project/:id       → zip download (SU-06)

# Agents (AP-06..08)
POST   /api/agents                   → create a profile, or clone a builtin into the workspace
PUT    /api/agents/:id               → update a workspace profile
POST   /api/agents/:id/enabled       → enable or disable (AP-07)
DELETE /api/agents/:id               → delete a workspace profile; a builtin reappears underneath
POST   /api/agents/reload            → force a reload (same as the MCP reload_agents)

# Templates (TP-04)
POST   /api/templates                → create, or clone a builtin
PUT    /api/templates/:id            → update a workspace template, including phase order
DELETE /api/templates/:id            → delete a workspace template

# Knowledge (KB-01..03)
POST   /api/knowledge                → create a base with its manifest
PUT    /api/knowledge/:baseId        → update the manifest
PUT    /api/knowledge/:baseId/doc    → write one document
DELETE /api/knowledge/:baseId        → delete a base, refused while attached to a project

# Vault (VT-01..03)
PUT    /api/vault/:entryId           → create or update an entry; values write-only
DELETE /api/vault/:entryId

# Projects and phases (TP-05..08, DO-04)
POST   /api/projects                 → create from a template with knowledge attached
POST   /api/projects/:id/knowledge   → attach a base
DELETE /api/projects/:id/knowledge/:baseId
POST   /api/projects/:id/phases      → add an ad-hoc phase (TP-08)
POST   /api/phases/:phaseId/launch   → launch or re-launch (TP-07)
POST   /api/phases/:phaseId/skip     → skip an optional phase
POST   /api/runs/:id/abort           → abort the run (OR-06)
POST   /api/projects/:id/resume      → put the project's paused chain back to work (OR-05)
POST   /api/doubts/:id/answer        → answer a doubt (DO-04)
POST   /api/projects/:id/doc         → write a file under the project's doc/ (MC-04 rules apply)
POST   /api/projects/:id/archived    → archive or unarchive the project (PM-08)
DELETE /api/projects/:id             → delete it for good; body {confirm:<the project id>, keepFiles?:bool} (PM-08, WP-11)
```

Retiring a project (PM-08) is two operations, not one. `archiveProject` flips `projects.archived`
and refuses new launches; nothing is removed, and unarchiving is the same call with `false`.
`deleteProject` is the irreversible one: it refuses while a run is active, deletes the project row
(every operational table cascades from it: chains, tasks, runs, events, doubts, decisions,
permission audit, phases, knowledge attachments), then removes the project directory under
`<workspace>/projects/` unless `keepFiles` is set — a path it recomputes from the workspace root
and the project id rather than trusting `projects.path`, so a doctored row cannot make it delete
somewhere else. The `project.deleted` event is written before the row goes, so the audit trail
survives what it describes.

Refusals are the same as through MCP, because they live in the actions: launching a phase on a
locked project queues it (OR-08), launching a disabled agent is rejected with the reason
(AP-07), deleting a template still referenced by no project is allowed and by a live project is
irrelevant (phases are frozen, TP-05), and writing outside `doc/` is refused (MC-04).

### 12.2 SSE (`GET /api/stream`) (WP-03)

- Named events: `overview` (debounced 500 ms, whenever anything changes), `run:<runId>` (per-run tail for the open project view), `doubt`.
- Each SSE `id:` is the `events.id` cursor; on reconnect the server replays rows `> Last-Event-ID` before resuming live (no gap, no duplicate).
- Keepalive comment every 15 s; client auto-reconnects with backoff. Target event→screen < 2 s.

### 12.3 Panel structure (ST-04)

Single `index.html`, no build step, hash routes:

| Route | Content |
|---|---|
| `#/` | Global. Attention strip first (open doubts with age, failures, auth problems — OB-03), then active runs and engine health. |
| `#/projects` | The project list of WP-10: one row per project with template, a phase bar (done / running / pending / skipped), open doubts and last activity. |
| `#/p/<id>` | Project. Current run card with elapsed/timeout and inactivity bars, the **phase list** with per-phase launch, re-launch and skip buttons (TP-07), plan checklist, doc summary, open doubts with answer forms (DO-04). |
| `#/p/<id>/history` | Past runs (WP-06). |
| `#/p/<id>/knowledge` | Attached bases, attach and detach. |
| `#/agents` | Agent library: builtins and workspace copies, enabled toggles, and the editor — engine, model, reasoning, instructions, policy pack, deliverable, tags (AP-06). |
| `#/templates` | Template library, **New template**, and the editor: id (on a new one), name, description, `requires_writable_knowledge`, plus the phase list — reorder, add, remove, pick the agent per phase, edit phase instructions (TP-04). Saving under a builtin's id writes the workspace copy that shadows it. |
| `#/knowledge` | Knowledge bases, their manifests and documents, and each base's **authority**: advisory or hard rules (KB-11). |
| `#/vault` | Vault entries, write-only value fields (VT-03). |
| `#/health` | Container, database, engines, disk. |
| `#/setup` | The first-run wizard, repeatable later (§14.3). |

Rendering: small vanilla-JS renderers fed by `fetch` + SSE patches; dark theme default (WP-08).
Forms post to §12.1b and re-fetch; nothing is optimistic, because the SSE stream is the truth.
Destructive buttons open a confirm dialog naming the object (WP-11). The HTML mockup already
produced for this project is the visual reference for `#/` and `#/p/<id>`.

### 12.4 A run told in words (OB-06, `src/narrate.ts`)

The timeline was twenty rows of `tool.call {"kind":"execute","title":"Terminal"}`. That says
something happened and nothing about what, and it was the same for the person watching the panel and
for a client reading MCP.

`describeEvent(type, payload)` turns one event into one line, and `narrate(events, limit)` folds the
runs of the same verb:

```
18:04  work      runs: find src -name '*.py' | wc -l
18:05  work      reads src/api/views.py (+7 more)
18:06  work      thinking: which base classes govern every endpoint
18:06  decision  judge: allowed — read-only count within the project
18:07  result    wrote doc/ANALYSIS.md
18:07  decision  run interrupted: container restart
```

Each line carries a `tone` — `work`, `decision`, `result`, `problem` — which is what the panel
colours by, and the count of events folded into it. Two changes made this possible at the source: a
`tool.call` now records the command it is about to run (`title` was often just "Terminal"), and the
agent's thinking is recorded as `agent.thought`, throttled exactly like a message.

**One implementation, three consumers.** `GET /api/runs/:id/narrative` serves the lines to the panel
— which re-reads them at most once a second rather than reimplementing the rules in browser
JavaScript — `project_status.recent` carries the last ten, and `status_card` prints them. The panel
keeps a "Raw events" toggle: when the narration itself is what looks wrong, the rows are still
there.

## 13. Build order and verification

| Phase | Delivers | Verifies requirements | Done when |
|---|---|---|---|
| 1 | Image + compose + volumes + login scripts + `/health` | RT-01..06, NF-01/03 | both engines authenticated inside the container; health green |
| 2 | DB layer + migrations + repos | DB-01..03 | schema applied; repos unit-tested |
| 3 | ACP runner for ONE run + policy engine + audit | SR-01..07, PE-01..04 | a real task runs end-to-end on a sample project with permissions mediated |
| 4 | Orchestrator chains + verify gate + git + docs | OR-*, PM-01..05 | a 3-task chain completes unattended |
| 5 | Doubts + advisor auto-continue | DO-01..05, SR-08, PE-06 | a seeded ambiguous task auto-continues on agreement and opens a doubt on disagreement |
| 6 | MCP server + stdio bridge + all tools | MC-01..06 | full flow driven from Claude Desktop only |
| 7 | Panel + SSE (read-only views) | WP-01, WP-03..09, OB-03 | chain progress visible live in the browser |
| 8 | Published image + first-run wizard + host workspace | SU-01..10, RT-02/04 | on a clean machine: pull, start, and the whole setup completes in the browser, with projects visible in the host file manager |
| 9 | Builtin library + templates + phases + knowledge + vault | BA-*, TP-*, KB-*, VT-*, PM-06/07 | a project created from `full-development` runs its phases in order through MCP, with knowledge injected and a phase gate held for a human |
| 10 | Panel write surface | WP-02/10/11, AP-06..08, TP-04, SU-05 | an agent and a template are created and edited in the browser, and a project is created and its phases driven from the browser alone |

Phase 9 before phase 10 on purpose: the templates, phases and knowledge model must be real and
driven end to end through MCP before a form is built on top of it. A UI over an unproven model
just hides where the model is wrong.

Each phase ends with its own verify script under `scripts/verify/` (the project applies its own medicine: green gate before moving on).

## 14. Setup, distribution and first-run onboarding (SU-01..10, phase 8)

Target experience on a clean machine: install Docker Desktop, run one line, open the panel.
Nothing else, and no terminal after that line.

### 14.1 Image publication (SU-01, SU-08)

`docker buildx` builds `linux/amd64` and `linux/arm64` and pushes to
`ghcr.io/<org>/lightsout` with `:x.y.z` and `:latest`. A GitHub Actions workflow builds on
tag. Updating is `docker pull` + restart: migrations run at boot, so no manual step (SU-08).
Volumes carry all state, so a container replaced by a newer image keeps credentials,
database and projects.

### 14.2 Start command (SU-02)

```
docker run -d --name lightsout --restart unless-stopped \
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 \
  -v lightsout-db:/data \
  -v "$HOME/LightsOut:/workspace" \
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex \
  ghcr.io/<org>/lightsout:latest
```

The workspace is a host folder (RT-02), so the projects are in the user's own file manager and
their IDE from the first minute. `Start-LightsOut.ps1` creates `%USERPROFILE%\Documents\LightsOut`
if absent and passes it as the bind mount; changing the path means editing one line at the top of
that script, or picking it in the wizard, which rewrites the same line. Everything else has a
working default (DESIGN §3.4), so no `.env` is needed.

Two details the bind mount forces:

- **File ownership.** The container runs as a non-root user; on Docker Desktop for Windows the
  bind mount is presented with permissive ownership, so nothing is needed. On a Linux engine the
  start script passes `--user $(id -u):$(id -g)` so files land owned by the user who will edit
  them.
- **Watchers.** Filesystem events on a Windows bind mount are unreliable, so the agent, template
  and knowledge loaders (AP-03) poll every 2 s by default (`LO_WATCH_POLL_MS`) instead of relying
  on inotify, and the panel keeps its explicit reload button.

`LO_WORKSPACE_MODE=volume` restores the managed volume for headless installs; the compose file
stays for maintainers and for the egress-restricted profile.

### 14.3 First-run wizard (SU-03)

The panel detects "not set up yet" from two facts read from SQLite and the health probe:
engines unauthenticated, no projects. The agent and template library needs no installing — it
ships in the image (BA-01, TP-02) — so the wizard is four steps, each independently repeatable
later from `#/setup`:

1. **Workspace.** Show the host folder currently mounted at `/workspace`, confirm it, and
   explain in one line that this is where the projects will be on their machine (RT-02). If the
   user wants another path, the panel shows the one line to change in `Start-LightsOut.ps1` and
   the restart button; it cannot remount itself from inside the container.
2. **Connect engines.** One button per engine (§14.4), or a field to paste an API key.
3. **Connect Claude Desktop.** `http://127.0.0.1:8484/mcp` with a copy button and the
   custom-connector instructions (SU-09), plus a "test connection" indicator that turns green
   when the first MCP call arrives.
4. **First project.** Name, template (the four builtins, TP-02), knowledge bases to attach
   (none on a fresh install), optional git remote and verify command; scaffolds through the same
   `createProject` action as MCP (PM-01, TP-05).

### 14.3b Windows entry points (SU-07, SU-09, SU-10)

Windows users get Docker Desktop and four numbered files under `scripts/windows/`, each a
double-click: start, connect Claude, connect Codex, build the extension. No shell and no Linux
distribution appear — the virtual machine Docker Desktop manages for itself is an implementation
detail the user never sees. The scripts locate `docker.exe` themselves, start Docker Desktop when
it is not running, and report state by reading `/health` instead of asking the user to interpret
anything.

Connecting Claude Desktop is a URL, not a file. Recent builds manage MCP servers through
connectors and extensions and never read `claude_desktop_config.json`, so the documented path is
pasting `http://127.0.0.1:8484/mcp` into the app's custom-connector dialog: no bridge process, no
`docker exec`, nothing to edit. The wizard shows the URL with a copy button.

`Connect-ClaudeDesktop.ps1` and `dist/mcp/stdio-bridge.js` remain for builds that still read the
config file. The script waits for the app to exit before patching, because Claude Desktop
rewrites that file with its own preferences on exit and an edit made while it runs is silently
lost — verified the hard way on this machine.

Maintainer verification runs the same bash gates against Docker Desktop through Git Bash, with
`MSYS_NO_PATHCONV=1` so container paths survive `docker exec` verbatim.

### 14.4 Login without a terminal (SU-04)

`POST /api/setup/login/:engine` spawns the engine CLI login inside the container and returns
a `flowId`; the panel subscribes to `GET /api/setup/login/:flowId` (SSE) and renders the URL
and code parsed from the CLI output, then the final state from a fresh auth probe.

The callback needs care. Both CLIs bind their loopback listener inside the container, which a
published port cannot reach (the mapping arrives on the container's external interface). A
small TCP forwarder (`src/net/forwarder.ts`, `node:net`, no new dependency) listens on the
container's non-loopback address, port 1455, and pipes to `127.0.0.1:1455`; the published port
then works. It runs only while a login flow is active.

The same forwarder serves the scripted path: `dist/cli/login.js <engine>` starts it, runs the
engine's login with inherited stdio and reports the resulting auth state. That is what
`scripts/windows/Connect-Engine.ps1` calls through `docker exec -it`, so a login needs neither
host networking nor a second container, and behaves identically on Docker Desktop and on a
Linux engine.

### 14.5 Getting at the project files from the host (SU-06)

With the host workspace of RT-02 this question mostly disappears: the project is already
`%USERPROFILE%\Documents\LightsOut\projects\<slug>` on the user's own disk, a normal git repo
they can open in VS Code, edit by hand, back up or push. LightsOut and the user are editing the
same files, and the only rule is the obvious one: do not hand-edit a project while a run is
active on it, because the agent is writing there too. The panel shows which projects have an
active run precisely so that is visible.

`POST /api/export/project/:id` remains for two cases: `LO_WORKSPACE_MODE=volume` installs, where
it is the only way out, and sharing a snapshot of a project without the whole workspace. It
streams a zip built from `git clone --local` plus `doc/`, so the history survives.

### 14.6 Boundaries (SU-05)

The panel's mutating surface is the routes listed in §12.1b and nothing else. The boundary is no
longer "the panel cannot control anything" — it can, and by design (WP-02) — but "the panel owns
no logic": every route is a call into `src/control/actions.ts` (§12.0), so the policy engine, the
project locks, the doubt lifecycle and the audit trail apply identically whichever surface asked.
All of it is localhost-bound (WP-09), and the pilot builds no auth.

## 15. Open implementation decisions

- Whether `session/load` resume is exposed by both adapters at pin time; if not, functional-doubt resume falls back to "new run with decision context" (already specified) with no design change.
- tinyproxy vs squid for the egress sidecar (feature-equivalent for this allowlist use).
- GHCR organisation/namespace for the published image (phase 8).
- Whether the egress allowlist (RT-05) can stay meaningful once `contract-prober` legitimately needs to reach arbitrary customer APIs. Likely answer: the vault entry's `base_url` host is added to the allowlist for the duration of that run, which keeps the allowlist a real boundary instead of quietly disabling it. To be settled when phase 9 reaches the prober.

Settled during implementation: ACP adapter packages and versions are pinned in the
Dockerfile and recorded in `doc/DECISIONS.md`.

## 16. Project templates and phases (TP-01..08, phase 9)

### 16.1 Template format

A template is one YAML file, id from the filename, under `builtin/templates/` or
`templates/*.yaml` in the workspace (shadowing by id, §2).

```yaml
id: full-development
name: Full development
description: >
  End-to-end delivery of a feature or a system, from a rough idea to audited and
  tested code. Use it when the result has to be maintainable.
when_to_use: >
  The result is code someone else will maintain, the scope is more than an
  afternoon, and correctness matters more than speed.
not_for: >
  Throwaway demos, one-off questions about an existing codebase, or anything
  where nobody will read the audit.
phases:
  - id: shape-the-prompt
    title: Turn the idea into a workable prompt
    agent: prompt-architect
    gate: human                # a person confirms the prompt before planning starts
    deliverable: doc/PROMPT.md
    instructions: |
      The user's raw request is in the task spec. Interrogate it. Name every risk
      you see, in plain words, without softening them. List what you cannot decide
      alone and raise a doubt for each. Produce doc/PROMPT.md covering scope,
      non-goals, actors, data, integrations, constraints, acceptance criteria and
      failure modes.
  - id: probe-contracts
    title: Probe the external contracts
    agent: contract-prober
    optional: true             # skip when nothing external is involved
    repeatable: true           # one run per integration is normal
    deliverable: doc/CONTRACTS.md
    instructions: |
      For every API or integration doc/PROMPT.md depends on, write real Python probes
      against the test credentials in the vault and record what actually happens …
  - id: plan
    title: Write the development plan
    agent: planner
    gate: human
    deliverable: doc/PLAN.md
    instructions: …
  - id: build
    title: Implement the plan
    agent: builder
    repeatable: true
    verify: npm test
    instructions: …
  - id: qa
    title: Regression and integration tests
    agent: qa-engineer
    deliverable: doc/QA-REPORT.md
    instructions: …
  - id: audit
    title: Audit the delivered code
    agent: software-auditor
    deliverable: doc/AUDIT.md
    instructions: …
```

`when_to_use` and `not_for` are the selection criteria (TP-10) and are separate from `description`
on purpose: a description says what the template *is*, and a caller choosing between six of them
needs to know when it *applies*. Both default to the empty string, so existing files stay valid, but
a template written from now on without them is a template nobody will pick correctly.

`zod` validates: unique `id` per phase, `agent` resolves to a loaded and enabled profile
(AP-07), `gate` in `auto|human`, `verify` a non-empty string when present, `deliverable` a
project-relative path, a `workspace:`-prefixed path, or a description. A `workspace:` deliverable
is only valid on a template that requires a writable knowledge base (§16.3), and a deliverable
containing `*` is treated as a glob: the check is "at least one match", not "this file exists". A template that fails validation is listed with its reason and
cannot be selected (TP-03) — exactly the agent-profile behaviour of AP-02.

### 16.2 Materialisation and execution (TP-05..07)

`createProject(actor, {template, …})` copies each phase into a `project_phases` row, in order,
with its instructions frozen (TP-05). Editing the template afterwards never rewrites a running
project: a project is a snapshot of a recipe, not a live reference to it. The alternative —
resolving the template at launch time — was rejected because it makes a project's history
unexplainable the moment someone edits a template.

Launching a phase creates a task in the project's chain with `spec` built from the phase
instructions plus the deliverable requirement, and points `project_phases.task_id` at it. The
chain loop of §5.2 is unchanged; phases sit above it:

```
launchPhase(actor, phaseId):
  phase   ← project_phases[phaseId]
  guard   ← phase.status is 'pending', or 'done'/'failed' with repeatable
  guard   ← agent(phase.agent_id) exists, enabled, engine authenticated   # AP-07, BA-06
  task    ← createTask(chain, position, phase.title, buildSpec(phase), phase.agent_id)
  phase   ← {status:'running', task_id:task.id, started_at:now}
  emit phase.state
  orchestrator.enqueue(task)     # OR-08 queues if the project is locked

onTaskClosed(task):
  phase ← project_phases where task_id = task.id
  if task.status ≠ 'ok':            phase.status ← 'failed';  stop
  if deliverable missing on disk:    phase.status ← 'failed';  reason 'deliverable missing'  # BA-04
  phase.status ← 'done'
  if phase.gate = 'human':          open a confirmation doubt; stop        # TP-01, DO-01
  else:                             launchPhase('system', nextPending())   # OR-02
```

A `human` gate reuses the doubt machinery rather than inventing a second waiting state. The
doubt has `kind='gate'` (§4), its options are "continue to <next phase>" and "stop here", its
context is the phase summary plus its deliverable, and answering "continue" calls
`launchPhase('system', …)`. It also skips the advisor consultation of §8.2: the whole point of a
gate is that a person looks, so asking the other engine first would be spending tokens to
produce an opinion nobody needs. A gate is therefore answerable from Claude Desktop, from the
panel, and mirrored into `QUESTIONS.md`, with no code beyond a `kind`.

`skipPhase` is allowed only when `optional`, sets `skipped`, and advances. An ad-hoc phase
(TP-08) is an insert into `project_phases` at a position; its `phase_id` is `adhoc-<n>` so it
never collides with a template id. `UNIQUE (project_id, position)` means the shift must run in
one statement in descending order —
`UPDATE project_phases SET position = position + 1 WHERE project_id = ? AND position >= ? ORDER BY position DESC`
— inside the same transaction as the insert. SQLite checks the constraint per row, so an
ascending update would collide on the first row.

One chain per project. `tasks.chain_id` is `NOT NULL`, so `createProject` creates the project's
chain immediately and every phase task joins it in position order; `project_status.chain` stays
optional in the contract only because a project created before phase 9 may not have one. The
pilot has no reason for a second chain per project, and `project_phases` is what carries the
plan anyway.

### 16.3 The builtin templates (TP-02)

*(The table below is the original four. The image ships six: `api-prototype` and `legacy-intake`
were added later, with the work that needed them.)*

| Template | Phases (agent) | For |
|---|---|---|
| `quick-prototype` | shape-the-prompt (`prompt-architect`, gate human) → build (`builder`, repeatable) → qa-smoke (`qa-engineer`, optional) | Proving an idea works. No planning phase, no audit: speed over durability, and the code is expected to be thrown away. |
| `full-development` | shape-the-prompt (human) → probe-contracts (`contract-prober`, optional, repeatable) → plan (`planner`, human) → build (`builder`, repeatable, verify) → qa (`qa-engineer`) → audit (`software-auditor`) | Work that has to survive. Two human gates, on the prompt and on the plan, because those are the two places where a wrong turn is cheapest to fix. |
| `knowledge-curation` | analyse (`codebase-analyst`, repeatable, deliverable `doc/ANALYSIS.md`) → interrogate (`codebase-analyst`, gate human, deliverable `doc/OPEN-QUESTIONS.md`) → write-base (`codebase-analyst`, deliverable `workspace:knowledge/<base>/index.md`) | Turning an existing system into a knowledge base (KB-07). The only template that runs with a writable knowledge base attached (KB-05). |
| `quick-answers` | answer (`answerer`, repeatable, no gate) | Questions against curated knowledge, or generic ones. One phase, launched again for each question, no verify. It exists so that asking something does not require creating a whole project ceremony. |

Three details of these four templates are load-bearing rather than incidental.

**The `interrogate` phase asks its questions as doubts, not through the gate.** A gate doubt is a
fixed two-option confirmation (§16.2); it cannot carry the analyst's own questions. So
`interrogate` writes what it could not determine into `doc/OPEN-QUESTIONS.md` and opens one
ordinary `functional` doubt per question it actually needs answered to proceed. Its gate then
means what every gate means: a person has read the deliverable and says go on. Getting this
backwards — overloading the gate with content — is the easy mistake here.

**`write-base`'s deliverable lives outside the project.** Deliverable paths are project-relative
by default; a `workspace:` prefix makes them relative to `/workspace` instead, and the §16.2
existence check resolves them accordingly. Only a phase whose project has a writable knowledge
base may declare one, which the template validator (TP-03) checks. `create_project` therefore
takes `writableKnowledge?: baseId` alongside `knowledge?: [baseId]`, and the curation template
is rejected at creation time without it.

**`quick-answers` has nothing to commit rather than a commit exemption.** Its agent `answerer`
runs the `no-write` pack, which denies every write class including `project_write`. The §5.2
chain loop still calls the consolidate step on `ok`; with a clean tree it is a no-op, so no
branch is needed. Its runs are `quick` level with a short timeout. `answerer` is
`prompt-architect`'s instructions inverted — answer directly and briefly instead of interrogating
— which is why it is its own builtin profile rather than a launch-time override: an override that
changes both the instructions and the policy pack is a different agent wearing a borrowed name.

The builtin policy packs are therefore seven: `default` (§7.2), `read-only` (writes allowed only
under `doc/`), `no-write` (no writes at all), `probe` (network and execute, writes confined to
`probes/`, `test_only_required`), `test` (execute plus loopback network, writes confined to the
test directories), `curate` (`knowledge_write: allow`, narrowed to the project's writable base)
and `advisor` (everything read-only, terminal denied — the pack the second-opinion sessions of
§8.2 already use). `default` and `advisor` were already shipping; the other five are new in
phase 9. *(Superseded: PE-14 reduced the packs to three — `read`, `build`, `build-network` — and
moved write scopes and capabilities onto the profile. See §7.2b; this paragraph is kept because the
reasoning for splitting them is still the reasoning for the three that remain.)*

### 16.4 Choosing a template is a decision, not a default (TP-09, TP-10)

**The failure this fixes.** Templates were listable and optional, so the cheapest path through the
MCP surface was `create_project` with no template followed by `launch_task`, and that is the path
clients took. Nothing was broken — every run worked — but phases, gates, deliverables and frozen
instructions went unused, which is most of what the system knows how to do. A feature that is
correct, documented and never reached is a feature that does not exist.

The cause is not ignorance, it is shape. Three fixes, all about shape:

1. **`template` is a required argument of `create_project`**, and `"none"` is a legal answer that
   requires `templateReason`. This is the `expects` lesson (§10.0b) applied again: a required field
   with an honest escape hatch changes behaviour, and a paragraph of documentation does not. The
   reason is stored on the project and shown in the panel, so "no template" stays a decision someone
   made rather than a default nobody noticed.
2. **The selection criteria travel with the template** (`when_to_use`, `not_for`, §16.1) and are the
   first fields of each `list_templates` entry. A caller comparing six templates needs the criterion,
   not the phase list; the phase list is what it needs *after* it has chosen.
3. **The omission is named where it hurts.** `launch_task` on a project that has a template and a
   pending phase adds a non-blocking `hint` to its envelope, naming the phase and `launch_phase`.
   It does not refuse: an ad-hoc task alongside a plan is legitimate (TP-08). It just stops being
   silent.

The server instructions (§10.0) carry one more line for the same reason — they are the only text
guaranteed to be in the client's context — and `guide{topic:"templates"}` remains the detail.

## 16b. Triggers (TR-01..07)

**What a trigger is, and what it is not.** It is a launch with a clock on it. It is deliberately
not a fifth noun beside project, phase, chain and agent: at the moment it fires it calls the same
`launchPhase` or `launchTask` the two surfaces call, and everything downstream — the chain, the
deliverable check, the gate, the doubt, the commit — happens exactly as it does when a person
presses the button. A scheduler that knew how to run work would be a second orchestrator.

```yaml
# a row in `triggers` (migration 15), shown here as the panel's form fills it
project: sector-news
cron: "0 7 * * 1-5"          # container timezone, five fields
phase: collect               # the repeatable phase this fires…
request: >                   # …and what is being asked, this time and every time
  Read yesterday's items from the sources in the brief and consolidate them.
expects: >
  knowledge/sector-news/index.md updated, with one line per item and its source.
enabled: true
```

**Why a phase and not a prompt.** A daily digest is a loop, and a template is an arc, so it would be
a category error to force the whole project through a template every morning. But the *work* is the
same every morning, and that is exactly what a `repeatable` phase already is (TP-07): frozen
instructions, a deliverable checked on disk, a gate if the work deserves one. So a trigger points at
a phase and passes the request; the free-task form exists for the one-off recurring thing that has
no plan around it, and it carries `request` and `expects` like every other launch (OR-10).

**Three ways a firing does not happen**, all recorded rather than silent (TR-03, TR-05):

| situation | what happens |
|---|---|
| a run of that project is in flight | skipped, `reason: busy`. Two runs of one project is not a thing (SR-07), and a queue of stale digests is worse than a missing one |
| the chain is paused | skipped, `reason: chain paused`. Something is waiting for a person; adding work on top of it buries the thing that needs attention |
| the phase is not pending, or is not repeatable | skipped, `reason: nothing to launch` |

**The missed firing (TR-04).** The scheduler ticks every 30 s and compares the previous scheduled
time with `last_fired_at`. That single rule covers both cases: a container that was off at 07:00 and
comes back at 09:00 sees that the 07:00 slot has passed and nothing ran in it, and runs once — not
five times for five missed days, because only the most recent slot is considered. A trigger created
after today's slot does not fire for it: `created_at` is the floor.

**Unattended (TR-07).** Creating a trigger on a project that is not unattended turns unattended on
and says so. The alternative — a digest that stops at 03:00 on a permission gate — is the failure
OR-12 exists to prevent, and a trigger is the strongest possible statement that nobody is watching.

### 21.3b Flags reach the program, or they are not added (PV-04 amended)

**The failure.** `npm run dev --host 0.0.0.0 --port 5170 --strictPort` reads correctly and does
nothing: npm keeps those flags for itself, so the script ran as `vite 0.0.0.0 5170`, vite ignored
the positional junk and bound `localhost:5173`, and the panel offered a link to 5170 where nothing
was listening. Every layer behaved as written; the composition was wrong.

Two rules now, and the second matters more than the first:

1. **A package script needs `--`.** `npm run dev -- --host 0.0.0.0 --port <n>` for npm, pnpm and
   bun; yarn forwards without it and warns about it, so yarn does not get one. Never added twice.
2. **A flag is only added to a program that has been identified.** Behind `npm run dev` there may be
   vite, `next dev`, `node server.js` or anything. While the flags were being eaten this was
   harmless; now that they arrive, an invented flag is a crash instead of a silent no-op. So
   `package.json`'s script body is read and the flags of *that* program are used — `--hostname` for
   next, `--strictPort` only for vite — and an unrecognised program is left exactly as written and
   steered with `PORT` and `HOST`, which the manager already puts in its environment.

The normalisation is recorded on the row and shown in the panel, which is how this was diagnosed at
all: the card showed the command it ran and the log showed vite announcing a different port.

**And a dead preview says so.** The row said `running` while the process was gone, and the panel
still rendered the link. `alive` (the row is running *and* the pid answers) was already computed and
was not used; now a preview whose process has died shows the URL struck through, names its log and
offers Stop. A link that cannot work is worse than no link.

**Cron.** Five fields, standard, no seconds and no `@daily` aliases: the parser is thirty lines and
lives in `src/triggers/cron.ts`, because a dependency for this would be a dependency to audit
forever. Times are the container's, which is UTC unless the compose file says otherwise, and the
panel says which timezone it is showing rather than pretending to know the user's.

### 16b.1 Saying when, without knowing cron (TR-08)

`0 7 * * 1-5` is precise, and it is also a small exam. Most schedules people actually want are one
of five shapes, so those are offered as shapes and cron stays underneath as the storage format —
one truth in the database, no second field to disagree with it.

```
every N minutes                     */N * * * *
every N hours at minute M           M */N * * *
every day at HH:MM                  M H * * *          (every N days: M H */N * *)
on chosen weekdays at HH:MM         M H * * 1,3,5
on day D of the month at HH:MM      M H D * *
custom                              whatever was typed
```

`src/triggers/schedule.ts` converts both ways and is shared, so the panel's form and
`create_trigger`'s `every` argument produce identical rows. Reading back (`cronToSchedule`) is
best-effort by design: a cron the shapes cannot express — `0 9 1,15 * 2` — opens as **Custom**
rather than being silently rounded into a shape that means something else.

Two honesty rules, because a scheduler that surprises people at 03:00 is worse than one that asks:

- **A step is a step, not a rhythm.** `*/7` in the minute field fires at :00, :07 … :56 and then
  jumps four minutes at the hour, and `*/3` in day-of-month restarts on the 1st of each month. When
  a chosen interval does not divide its field evenly, the description says exactly which values it
  fires on rather than repeating the comfortable lie "every 7 minutes".
- **Nothing is saved on trust.** Every surface echoes the schedule in plain language *and* the next
  time it will fire — `describeSchedule` and `nextFire` — before the row exists. The panel shows both
  live under the form; `create_trigger` returns them.

## 17. Curated knowledge (KB-01..07, phase 9)

### 17.1 Base format

```
knowledge/legacy-core/
├── knowledge.yaml
├── index.md
├── architecture.md
├── data-model.md
└── business-rules.md
```

```yaml
id: legacy-core           # must equal the directory name
name: Legacy core
kind: technical           # technical | functional | organisational | market | other
enforcement: advisory     # advisory (default) | hard  — see §17.4
description: How the legacy core is structured and what its invariants are.
tags: [core, legacy, sql-server]
owner: platform@example.com
updated: 2026-07-25
```

### 17.1b Which base may be written into (KB-05 amended)

**The failure this fixes.** Two rules that were each right made a third thing impossible. A folder
directly under `knowledge/` becomes a base in place; anywhere else it becomes a base that *links* to
the folder — and a linked base was never writable. So `knowledge/hispatec/mercado` could not be
curated by an agent, although it is inside the knowledge area and belongs to nobody else. The
session that hit this concluded the two existing bases were read-only "because they were written by
hand", which was the wrong lesson from the right observation.

The ban exists because the folder belongs to **something else** — the user's own source tree,
another project — and an agent rewriting it would be editing material outside its remit. Nesting
was never the reason; it only looked like it, because "directly under `knowledge/`" was how a base
in place was recognised. So the rule is now where the documents *are*:

| the base's documents live | writable |
|---|---|
| in its own `knowledge/<id>/` | yes |
| under `knowledge/` anywhere else, via `source` | **yes** — same area, same owner |
| outside `knowledge/` | no, and the refusal says to copy the material in |
| in a base with `enforcement: hard` | no, whatever the path (KB-11c) |

**And the classifier has to agree.** It derived the writable directory as `knowledge/<id>`, which is
only the default: a nested base would have been attachable and then had every write to it classified
`outside_workspace` — attachable and unusable, the worst of both. The runner now passes the base's
real `docsDir` and the classifier uses it, falling back to `knowledge/<id>` when it is absent.

`kind` says what sort of fact the base holds; `enforcement` says what the agent may do about it.
They are separate on purpose: a design system is `kind: technical` and `enforcement: hard`, while
an analysis of a legacy system is technical and advisory. Collapsing them into one field would have
forced a choice between describing the content and describing its authority.

`index.md` is a table of contents with one line per document saying what is in it. It is always
injected in full, whatever the budget, because it is what lets an agent ask for the right
document. The name is matched case-insensitively: a folder that arrived with `INDEX.md` keeps it,
and the container's filesystem is case-sensitive where the person who wrote it was not.

A document is a text file: `.md`, `.markdown` or `.txt`. Nothing else is accepted, by the
uploader or by the loader, because what a base is *for* is text that goes into a prompt — a PDF
sitting in the directory would be a document the agent is told exists and cannot read.

#### A base is a tree (KB-09)

Documents are found in subfolders too, and a document's id is its path inside the base:

```
knowledge/product-docs/
├── knowledge.yaml
├── INDEX.md
├── functional/
│   ├── menus.md
│   └── reports.md
└── technical/
    ├── api-auth.md
    └── api-entities.md
```

`read_knowledge("product-docs", "technical/api-auth.md")`, and the injection header reads
`--- knowledge: product-docs (technical) — technical/api-auth.md ---`. The path travels with the
document because it is usually how the person who organised the folder said what it is about, and
throwing it away would discard the only structure they gave. The walk is bounded (`MAX_DEPTH` 8,
`MAX_DOCUMENTS` 500 per base) and skips hidden directories.

#### Linked bases (KB-08)

A base may name a folder instead of holding the documents itself:

```yaml
id: platform-docs
name: Platform documentation
kind: technical
source: docs/platform         # relative to the workspace root; the folder stays the source of truth
```

With `source` set, `knowledge.yaml` and `index.md` still live in `knowledge/<id>/`, but the
documents are read from `<workspace>/<source>/` on every load, so a file dropped in there with
the file explorer is visible to the next session without touching the panel. The path is resolved
against the workspace root and refused if it escapes it, points at `knowledge/` itself or is
absolute: the container only sees the workspace (RT-02), and a manifest arrives from a browser.

`GET /api/knowledge/folders` walks the workspace tree — depth first, alphabetical, bounded at 2000
folders and 12 levels — and reports, for every folder including the ones under `knowledge/`: its
depth, how many text documents it holds **counting subfolders**, whether it has children, whether
it already is a base, and whether it could become one. That is the workspace as it really is,
which is the point: a person who dropped a folder of Markdown in there should see it and its
document count, not an empty picker. There is no folder dialog to offer instead — a browser cannot
hand a server a path, and a folder elsewhere on the host is not on the container's filesystem at
all.

A linked base is never writable — `writableKnowledge` refuses it (KB-05), because the curation
project would be editing a folder that something else owns.

#### Adopting a folder (KB-10)

A folder that holds documents and no `knowledge.yaml` is an invitation, not an error. It is
reported as `adoptable` rather than rejected, and `POST /api/knowledge/adopt`
(`adopt_knowledge` through MCP) makes it usable by writing only what is missing:

- **A folder under `knowledge/`** becomes the base in place. Its own name is the base id, the
  manifest is written next to the documents, and nothing moves.
- **A folder anywhere else in the workspace** gets a base in `knowledge/<id>/` that links to it
  with `source` — the folder is left untouched, exactly as §17.1 requires of a linked base.

An `index.md` is written only when the folder has none in any case, and `knowledge.yaml` is never
overwritten: adopting a folder that is already a base is refused, with the base named. LightsOut
generates what the system needs to accept the folder and not one byte more, because the folder is
the user's and it was there first.

### 17.2 Injection (KB-04, KB-06)

`inject.ts` builds block 3 of the prompt (§6.2):

1. Every attached base's manifest, and its `index.md`, always. Cheap and it prevents the worst
   failure mode, which is an agent not knowing that the answer exists somewhere.
2. Documents in full until `LO_KNOWLEDGE_BUDGET_CHARS` (default 120 000) is spent, ordered by a
   deliberately dumb score: tag overlap with the project's tags and the phase title, then
   `updated` descending. Ties break on document size, smallest first, so the budget buys breadth.
3. Anything not injected is listed as available, with the exact `read_knowledge(baseId, path)`
   call that fetches it. The agent has a file system anyway (the bases are mounted read-only at
   `/workspace/knowledge`), so this is a pointer, not a gate.

Every document is wrapped with its base id and kind:

```
--- knowledge: legacy-core (technical) — data-model.md ---
```

That labelling is the point of KB-02: an agent that cannot tell "the organisation prefers X"
from "the database enforces X" will treat a preference as a constraint, or worse, the reverse.

### 17.3 Writing (KB-05, KB-07)

The bases are mounted read-only for every project except the one case where a
`knowledge-curation` project declares a target base at launch; then that one base is writable
and appears in `project_knowledge` with `writable=1`. The policy engine classifies writes under
`/workspace/knowledge/<other-base>/` as `outside_workspace` and denies them (§7.1), which is the
backstop if the mount is ever wrong.

The curation project's pack, `curate`, is the only one whose `knowledge_write` verdict is
`allow`, and the runner narrows it further: the grant applies to the single base id recorded
`writable=1` for that project, not to `knowledge/` at large.

### 17.4 Hard rules (KB-11)

A base with `enforcement: hard` holds decisions that have already been taken: a design system, a
strict technology directive, a mandatory architectural constraint. The difference from advisory
knowledge is not how important it is, it is who may overrule it.

**Injection (KB-11a).** Hard rules go **first**, ahead of advisory knowledge and ahead of the
project's own docs, under a header that says what they are and what the agent must do about them:

```
# Binding rules — you may not decide against these

These are not context to weigh. They were decided before this task and are not being reopened
here. If completing the task would require contradicting one of them, that decision is not yours
to take: stop, and end your turn with the result sentinel carrying `hardRule`.

--- knowledge: design-system (hard rule · technical) — spacing.md ---
…
```

Advisory bases keep the header they have: `--- knowledge: <id> (<kind>) — <file> ---`. Hard-rule
documents are injected **in full, ahead of everything, and are not budgeted** (§17.2): a binding
rule dropped to save characters would leave the agent bound by something it was never shown. One
that cannot be read is stated as unreadable rather than passed over silently.

**The doubt (KB-11b).** A sentinel whose doubt payload carries `hardRule` opens a doubt of kind
`hard_rule`. It is
the one kind that **skips the advisor entirely** and can never auto-continue, however confident
anything is:

- `secondOpinion` is not called, so no `advisor.consulted` event exists for it.
- It does not count against `MAX_AUTO_CONTINUE`: a budget for provisional decisions has nothing to
  say about a doubt that can never be one.
- The doubt records which rule and which document, so the answer is about a specific rule rather
  than a general impulse.

The reason for skipping the advisor is not cost. A hard rule exists because a person decided
something; letting the other engine agree that breaking it is reasonable would be exactly the
failure mode the flag is there to prevent.

**Writability (KB-11c).** A hard-rule base is never the writable one, whatever a template declares
at launch. The runner drops it from the writable slot and records why. An agent that can edit the
rules binding it is not bound by them.

**What this does and does not guarantee (KB-11d).** Nothing parses a design system to detect a
violation — enforcement is by instruction and self-report. What the machinery guarantees is
narrower and still worth having: a violation the agent *does* declare cannot be waved through by
the advisor, by the auto-continue budget, or by anything other than the user answering it. Said
plainly here because a reader who assumed otherwise would trust the flag further than it deserves.

## 18. Credentials vault (VT-01..06, phase 9)

`vault.yaml` in the workspace root, listed in the workspace `.gitignore`, mode 600:

```yaml
entries:
  - id: sandbox-api
    label: Sandbox API
    base_url: https://sandbox.example.com/api/v2
    auth: bearer            # none | basic | bearer | api_key | oauth2_client_credentials
    test_only: true
    scope: ["*"]            # project ids, or "*"
    notes: Rate-limited to 60 rpm. The /orders endpoint paginates from 1, not 0.
    fields:
      token: "…"            # values live here and only here
```

Reaching an agent: before a run whose agent's policy pack grants `network access`, the runner
resolves the entries in scope for that project and injects each field as an environment
variable of the adapter process — `LO_VAULT_SANDBOX_API_TOKEN` — and writes a `vault.read`
event plus a `vault_audit` row with the field names only. The prompt gets the index (labels,
URLs, notes, variable names), never a value (VT-02). Values are excluded from `scrubbedEnv` for
every other run, so an agent with no network grant cannot see them at all.

**The id is internal and derived from the label (VT-08).** The same rule as knowledge bases
(KB-12), for the same reason and after the same failure: an id has to be a lowercase slug because
it becomes part of an environment variable name (`LO_VAULT_<ENTRY>_<FIELD>`), and asking a person
to satisfy that rule is asking them to do the system's arithmetic. `POST /api/vault` takes a label
and derives `slugify(label)`, with `-2`, `-3`… when that is taken. `PUT /api/vault/:id` edits an
existing entry and **never renames it**: the id is referenced by the variable name a script already
uses and by `scope`, so a rename would break work that is running.

And what is stored is normalised on read rather than rejected. One entry saved with an uppercase
id — `DEVEXTREME` — made the whole file fail validation, which made `list_vault` fail, which made
*every run* fail before it started, with a zod error nobody could connect to a credential. A file
the system wrote in an older shape is a migration, not a fault: on load, an id that is not a slug
becomes `slugify(id)`, or `slugify(label)` when there is nothing left of it, and a collision after
normalising gets the same `-2` suffix. The file itself is rewritten in the canonical shape the next
time anything writes to it.

The panel's `GET /api/vault` returns `{id, label, base_url, auth, test_only, scope, notes,
fields: [{name, present, updated}]}`. A `PUT` with a field omitted leaves the stored value
untouched; a field set to `null` clears it. There is no route that returns a value, which is why
the browser can never leak one (VT-03).

An agent that needs an entry which is absent or has an empty field opens a doubt naming the
entry id and the fields it needs (VT-04). That is a functional doubt like any other, so it
reaches the user through both surfaces and waits without burning the run.

`test_only` (VT-06) is enforced in the resolver, not the prompt: a pack may declare
`vault: test_only_required: true` — the `probe` pack does — and then entries without
`test_only: true` are excluded from the injected set and from the prompt index, with a
`perm.verdict` audit row recording the refusal. The prober therefore cannot reach a production
system by mistake even if someone stored its credentials in the vault, and the reason is visible
rather than a confusing 401.

## 19. The builtin agent library (BA-01..06, phase 9)

Twelve profiles in `builtin/agents/`, with the policy packs they need in `builtin/policies/`. Eleven
do work; the twelfth, `permission-judge` (claude / haiku / low, `advisor` pack), is internal and is
never launched as a phase — it answers the gate question of §6.5b.
Defaults below; every one is overridable per installation, per project and per launch (BA-03).

| id | Engine / reasoning | Policy | Deliverable | What it is for |
|---|---|---|---|---|
| `prompt-architect` | claude / high | `read-only` | `doc/PROMPT.md` | Turns a rough request into a prompt another agent can act on. Asks questions, states risks bluntly, refuses to fill gaps by assumption. |
| `contract-prober` | codex / medium | `probe` (network + execute, no source writes outside `probes/`) | `doc/CONTRACTS.md` | Finds out how an API actually behaves by calling it with Python and test credentials, before anything is built on top of it. |
| `planner` | claude / high | `read-only` | `doc/PLAN.md` | Writes the plan: contracts, specifications, edge cases, order of work. Ambiguity is the defect it exists to remove. |
| `builder` | claude / medium | `default` | code + tests | Senior developer. Executes one piece of an unambiguous plan and nothing beyond it. |
| `integrator` | claude / medium | `integrate` (network + writes anywhere in the project + the vault) | the working integration | Calls a real system and writes the code that calls it. Exists because no pack combined the three things an integration needs: `probe` had the network but wrote only in `probes/`, `default` wrote in the repo but had no network. |
| `coordinator` | claude / medium | `read-only` | — | Owns the project across phases, answers other agents' doubts, asks the user for what is missing. Normally embodied by Claude Desktop rather than launched as a run; the profile exists so it can be run headless. |
| `software-auditor` | codex / high | `read-only` | `doc/AUDIT.md` | Audits code, test coverage and engineering practice at the end of a development phase. Runs late and rarely, on purpose. |
| `qa-engineer` | claude / medium | `test` (execute + network to localhost, writes confined to the test directories) | `doc/QA-REPORT.md` | Writes and runs regression and integration tests, including a scripted walk through the web interface, and reports what passed and what did not. |
| `codebase-analyst` | claude / high | `curate` (read-only over source, writes only into the project's writable base) | `workspace:knowledge/<base>/*.md` | Reads an existing system until it understands it, asks the questions it cannot answer alone, and writes it up in KB format so the next project starts informed. |
| `answerer` | claude / low | `no-write` | the answer itself | Answers a question against the attached knowledge, briefly and without ceremony. The `quick-answers` template's only agent (§16.3). |
| `reviewer` | codex / medium | `read-only` | review notes | The existing per-task code reviewer. |

Two engine choices deserve a word. `contract-prober` and `software-auditor` default to Codex
because both jobs are adversarial towards work the other engine produced, and a second opinion
from a different model is worth more than a marginally better one from the same family — the
same reasoning as the advisor of §8.2. Both are one dropdown away from being changed (AP-06).

Policy packs enforce BA-05 rather than trusting instructions: `read-only` denies every write
class outside `doc/`, so `planner` physically cannot edit source, and `probe` grants network and
execution but confines writes to `probes/`, so a probing session cannot start implementing what
it was only supposed to describe.

The deliverable is checked on disk when the phase closes (§16.2). An agent that reports success
without producing its deliverable fails the phase, which is the cheapest available defence
against a confident summary of work that did not happen (BA-04).

## 20. Machine-first documents (BA-07, BA-08)

### 20.1 Why

A real deliverable on this machine reached **40 KB of Spanish prose** across six passes of a phase
that had produced no practical work: a chronicle of what had been attempted, each pass restating the
previous one, with the facts buried inside it. Every later run pays for that file in tokens, twice —
once to write it, once to read it back — and the more it says the less it tells.

The rule is therefore not a size limit. It is that these documents are **written for the machine that
reads them next**: one fact per line, `key: value`, no prose, no history of attempts, and nothing
that does not add a fact.

### 20.2 What the rule applies to

Every Markdown file **the system itself** writes or reads back:

- phase deliverables (`doc/ANALYSIS.md`, `doc/PLAN.md`, `doc/AUDIT.md`, `doc/QA-REPORT.md`, …),
- the managed project docs (`STATE.md`, `PLAN.md`, `DECISIONS.md`, `QUESTIONS.md`, `OPEN-QUESTIONS.md`),
- documents written into a curated knowledge base (§17), because they are injected into prompts.

It does **not** apply to anything a human asked for as a human document, nor to any other output
format the user requested. A file that is deliberately prose declares it on its first line and every
check skips it:

```
<!-- lightsout:audience=human -->
```

### 20.3 The format

```
# ANALYSIS :: curacionapi-efemis
meta.doc: ANALYSIS
meta.updated: 2026-07-26
meta.phase: analyse
meta.status: blocked
meta.blocked_on: sources_missing

## gaps
| id | gap | needs | source | confidence |
|---|---|---|---|---|
| G-1 | endpoint list unknown | sources/ populated | doc/OPEN-QUESTIONS.md#q.4 | high |

## facts
f.1.claim: base efemis has 38 undocumented fields
f.1.source: knowledge:efemis/tecnico/api.md
f.1.kind: preference
f.1.confidence: medium
```

`doc/examples/ANALYSIS.machine-first.md` is the canonical example: the 40 KB narrative that caused
this rule, rewritten to 19 KB with every fact, id and source preserved and the chronicle of passes
gone. It is also the file that was copied over the live deliverable.

Rules, all of them stated in the protocol block so every agent gets them:

1. Every line is a `key: value` pair, a table row, a heading or a fenced block. No paragraphs.
2. Keys are English `snake_case`, dotted for structure. Ids are stable (`f.1`, `G-1`) so another
   document can point at them instead of repeating them.
3. One fact per line. Values carry no adjectives that do not change the fact, and no sentence that
   could be a key.
4. **Supersede in place.** The document is the current state, not a log. No "pass 6", no "as
   established above", no reproducing what a previous version said. A counter (`meta.passes: 6`) is
   the whole history anyone needs.
5. Every claim carries `source:` — `code:<path>:<line>`, `schema:<object>`, `doc:<path>#<id>`,
   `knowledge:<base>/<doc>`, `human:<doubt ref>` — and `confidence:` when it is not derived from one.
6. Do not restate the task, the instructions, the protocol, or another document. Reference it.
7. Three or more items with the same shape become a table.
8. No decoration: no emphasis for tone, no summaries of what the document just said, no closing
   paragraph.
9. Keys are always English; values may be in the project's language (RT-08 governs this repository,
   not the user's project).

### 20.4 The check (`src/projects/deliverable.ts`)

`lintDocument(text)` is a pure function returning metrics and a verdict:

| metric | meaning | fails at |
|---|---|---|
| `structureRatio` | keyed, table, heading or fenced lines ÷ non-empty lines | `< 0.70` |
| `proseLines` | non-keyed lines longer than 12 words | `> 5%` of non-empty lines |
| `longestParagraph` | consecutive non-keyed, non-empty lines | `> 3` |
| `duplicationRatio` | repeated normalised 3-line windows | `> 0.15` |

`bytes` and `lines` are reported and **never** a verdict: there is no size limit. The thresholds are
a heuristic and are named as such — the check exists to catch drift, not to grade writing.

It runs in two places:

- **At task close**, on the phase's deliverable: `deliverable.lint` event with the metrics and the
  reasons, visible on the run timeline. A failing lint never fails the phase (BA-08).
- **At prompt time**, on the deliverable that already exists: when it fails, the prompt carries a
  short block naming the metrics and instructing the agent to compact the document and remove what
  repeats **before** adding anything. That is what makes the rule self-correcting without a gate: the
  agent that has to live with the file is the one told to fix it.

## 21. Preview servers (PV-01..06)

### 21.1 The three things that were broken

A project whose deliverable is a page had no way to show it, and each cause is separate:

1. **The container publishes 8484 and 1455 and nothing else.** A Vite on `:5173` inside is
   invisible from the user's browser however well it runs.
2. **A dev server never ends.** Run as an ordinary terminal command it holds the run's terminal
   open, produces no further events, and the inactivity watchdog (SR-04) eventually kills the run
   that started it. The agent did nothing wrong and the run failed anyway.
3. **`vite`, `next dev` and `python -m http.server` matched no rule**, so they fell to `other` and
   a human gate — for the one command the task exists to run.

### 21.2 A preview is owned by LightsOut, not by the agent

```
preview_start { projectId, command, port?, cwd? }  → { port, url, previewId, logPath }
preview_stop  { previewId | projectId }
list_previews { projectId? }
```

`src/preview/manager.ts` allocates a free port from the pool, spawns the command **detached, in its
own process group**, with `stdout`/`stderr` to `<project>/.lightsout/tmp/preview-<port>.log`, and
returns within a few hundred milliseconds. Nothing about it is attached to the run: the run ends,
the preview is still up, and that is the point — the user looks at the result after the agent has
finished (PV-03).

**The pool** is `127.0.0.1:5170-5189` in compose, twenty simultaneous previews, loopback only. The
port is a fact about the host, so `preview_start` reports the URL the user's browser can actually
open, not the container's.

**Reaped by four things**, because a process nobody can see and nobody stops is worse than no
feature: `LO_PREVIEW_TTL_MIN` (120 by default, checked by a one-minute sweep), an explicit
`preview_stop`, the project being deleted or archived, and the boot recovery pass — the table is
memory of a process the container restart already killed, so boot clears it.

**Storage** is a table rather than a map, so the panel and MCP read one truth:
migration 10, `previews(id, project_id, port, command, cwd, pid, log_path, started_at, expires_at,
started_by, status)`.

### 21.3 Two things that break a containerised dev server, handled here (PV-04)

**Binding.** Vite, `next dev` and `http.server` bind `localhost` by default, which inside a
container is the container's own loopback: publishing the port changes nothing and the browser gets
a connection reset. This is the failure that looks like Docker being broken and is not. So the
command is normalised before it runs — `--host 0.0.0.0`, the allocated port, `--strictPort` so a
busy port is an error rather than a silent move to another one the publish does not cover — and the
normalisation is recorded on the preview row, because a command the system rewrote must be visible.

**CORS.** A prototype served from `:5173` calling an API on another origin fails in the browser, and
the agent cannot fix it from inside the page. `lo-serve` (`src/preview/serve.ts`, Node, no
dependencies) is the static server LightsOut ships: it answers `Access-Control-Allow-Origin: *`,
handles `OPTIONS` preflight, and takes `--proxy /api=<upstream>` to forward a path to a declared
upstream so the page talks to one origin. For a real Vite project the same job is Vite's own
`server.proxy`, and the preview's log is where a misconfiguration shows up.

### 21.4 The class, the capability and the pack (PV-05, PV-06)

A new action class **`serve`**, matching `vite`, `next dev|start`, `nuxt dev`, `ng serve`,
`npm|pnpm|yarn run dev|start|serve|preview`, `python -m http.server`, `http-server`, `serve`,
`live-server`, `caddy`, `php -S`. Inline, it is **denied** with a reason that names the way to do
it:

> a development server run in the terminal never ends and the run's inactivity watchdog will kill
> it. Start it with `preview_start` instead: LightsOut owns the process, publishes the port on the
> user's machine and keeps it alive after this run finishes.

That is deliberate: a `require_human` here would let a person approve the thing that hangs the run.
Through `preview_start` it is governed by the `serve` capability, which packs grant.

**`web-prototype` pack and the `web-prototyper` agent** (thirteenth builtin, ninth pack): writes
anywhere in the project, `serve`, `toolchain_install`, `exec_check`, `script_exec`, `git_local`;
**no network**. A prototype is buildable without anything that reaches off the machine, and the
toolchain volume (§7.6) is what makes `npm install vite` survive to the next run.

### 21.5 Where it shows

`status_card` and `project_status` carry the live preview and its URL; the panel has a Preview card
per project with the URL as a link, the age, the last lines of the log and a Stop button. A preview
whose process has died is reported as dead rather than linked: the manager checks the pid before
answering, because a URL that does not load is worse than no URL.
