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

### 6.6 Watchdogs (SR-04)

Per run: hard timer (`quick`→`LO_TIMEOUT_QUICK_MIN`, `full`→`LO_TIMEOUT_FULL_MIN`, task override allowed) and inactivity timer re-armed on every persisted event. Expiry: `session/cancel`, grace 10 s, `SIGTERM` the adapter, status `timeout`/`stuck`, recovery info persisted (acp_session id enables resume where supported, SR-06).

### 6.7 Cost capture (SR-05)

From ACP turn metadata when the adapter reports usage; `cost_usd` stays NULL otherwise (Codex reports tokens only — mirrored from the current system's experience). Never estimated.

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

### 9.2 Managed doc sections (PM-02)

`STATE.md` mixes free text with a machine-owned block, regenerated at every task close from the DB:

```
<!-- lightsout:begin -->
Phase: chain "Offline sync" 4/6 · last: Tests green (task 4)
Last decision: incremental sync (D-7, human, 2026-07-24)
Next: task 5 — sync status screen
<!-- lightsout:end -->
```

Everything outside the markers is never touched. `PLAN.md` uses one checkbox line per task with the task id in a trailing tag (`- [x] Wire repository  <!-- lo:t_01H… -->`); the orchestrator flips checkboxes by id. DECISIONS.md and QUESTIONS.md are append-only (§8.3).

### 9.3 Git strategy (PM-04, PM-05)

- `create_project`: `git init` if needed, `.lightsout/tmp/` created with a `.gitignore` that ignores
  the whole `.lightsout/` directory (PE-08), then the initial commit of the scaffold.
- During a run: wip commit every 10 min if dirty and at run end — `wip(lightsout): <taskId> <ts>`.
- Task ok: consolidated commit `feat: <task title> [lo:<taskId>]` (wips remain in history; squashing is v2).
- Provisional decision: annotated tag `lightsout/cp/<taskId>-<n>` at the pre-decision commit (the v2 rewind target).
- Push: orchestrator-only (`git_push` is `deny` for agents), `push_policy=auto` requires verify green in the same task cycle; `--force` is not implemented at all. Credentials: mounted ssh key or `GIT_TOKEN` via credential helper; never persisted (NF-02).

## 10. MCP server (MC-01..06)

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
| `create_project` | `{name, template?, knowledge?:[baseId], writableKnowledge?:baseId, remote?, verify?, push?}` | `{project:{id,path}, phases:[{phaseId,title,agentId,gate}]}` | scaffolds and materialises the phases (PM-01, TP-05); `writableKnowledge` is required by the curation template and refused by every other (KB-05) |
| `project_status` | `{projectId}` | `{project:{…,templateId,knowledge:[…]}, phases:[{phaseId,title,agentId,status,deliverable,gate,startedAt,endedAt}], chain?:{id,title,tasks:[…]}, run?:{id,status,engine,model,elapsedS,inactivityS,lastAction,timeoutS}, doubts:[…], state:{phase,lastDecision,next}}` | one call = full picture including what is done, running and pending (MC-06, TP-06) |
| `list_agents` | `{}` | `{agents:[{id,name,engine,model,enabled,source,valid,error?}]}` | AP-02, AP-07, BA-01 |
| `write_agent` | `{agentId, name?, engine?, model?, reasoning?, instructions?, policy?, tags?, deliverable?, advisor?, enabled?}` | `{agent:{…}}` | create or edit; on a builtin it writes the workspace copy that shadows it (AP-06). An unknown model is rejected with the accepted list (AP-08) |
| `set_agent_enabled` | `{agentId, enabled:bool}` | `{agent:{id,enabled}}` | AP-07 |
| `delete_agent` | `{agentId}` | `{revealedBuiltin:bool}` | deletes the workspace copy; a builtin of the same id reappears under it (AP-06) |
| `reload_agents` | `{}` | `{loaded,rejected:[{file,error}]}` | AP-03 |
| `list_templates` | `{}` | `{templates:[{id,name,description,source,phases:[{id,title,agentId,gate,optional,repeatable}],valid,error?}]}` | TP-03 |
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
| `resume_chain` | `{projectId?, chainId?}` | `{chainId, requeued:[ids], started:bool}` | OR-05. The counterpart to the pause: queues the tasks that did not finish and leaves `ok` ones alone. Never automatic — a chain paused by a container restart or a failed task had no way back before this |
| `list_doubts` | `{projectId?, status?:'open'}` | `{doubts:[{id,ref,projectId,taskTitle,kind,context,blocks,options,recommendation,secondOpinion?,ageMin}]}` | Desktop renders options as buttons (MC-03) |
| `answer_doubt` | `{doubtId, choice, note?}` | `{resumed:bool, runId?}` | DO-04; `doubtId` accepts the ulid or the `ref` (`D-3`) when `projectId` context is unambiguous |
| `get_history` | `{projectId?, limit?:20, before?}` | `{runs:[{id,task,engine,model,status,startedAt,durationS,costUsd?,summary}], totals:{byStatus,costUsd}}` | OB-05 |
| `read_doc` | `{projectId, doc:'STATE'\|'PLAN'\|'DECISIONS'\|'QUESTIONS'}` | `{content, updatedAt}` | |
| `write_doc` | `{projectId, doc, content}` | `{written:true}` | rejected if a run is active on the project (`CONFLICT`); scoped to doc/ (MC-04) |
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

### 16.3 The four builtin templates (TP-02)

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
phase 9.

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

Ten profiles in `builtin/agents/`, with the policy packs they need in `builtin/policies/`.
Defaults below; every one is overridable per installation, per project and per launch (BA-03).

| id | Engine / reasoning | Policy | Deliverable | What it is for |
|---|---|---|---|---|
| `prompt-architect` | claude / high | `read-only` | `doc/PROMPT.md` | Turns a rough request into a prompt another agent can act on. Asks questions, states risks bluntly, refuses to fill gaps by assumption. |
| `contract-prober` | codex / medium | `probe` (network + execute, no source writes outside `probes/`) | `doc/CONTRACTS.md` | Finds out how an API actually behaves by calling it with Python and test credentials, before anything is built on top of it. |
| `planner` | claude / high | `read-only` | `doc/PLAN.md` | Writes the plan: contracts, specifications, edge cases, order of work. Ambiguity is the defect it exists to remove. |
| `builder` | claude / medium | `default` | code + tests | Senior developer. Executes one piece of an unambiguous plan and nothing beyond it. |
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
