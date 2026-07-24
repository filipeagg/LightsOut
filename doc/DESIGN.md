# LightsOut — Technical Design

Status: draft for review
Companion to: REQUIREMENTS.md (requirement IDs referenced throughout)
Stack: TypeScript / Node.js 22, single process, SQLite (WAL), ACP, MCP. See REQUIREMENTS.md ST-01..ST-05.

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
│  /workspace (bind mount, WSL2 ext4)      /home/app/.claude  .codex (vols)│
│    ├── agents/    (profiles + policies)                                   │
│    └── projects/  (one dir per project, own git repo)                     │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ MCP (Claude Desktop)                    ▲ browser (read-only)
```

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
│   │   ├── loader.ts             # load + watch agents/*.yaml (AP-01..03)
│   │   └── schema.ts             # zod schema for profiles
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
│   └── http/
│       ├── server.ts             # Fastify: static panel, JSON API, /health
│       └── sse.ts                # /api/stream (§12.3)
├── panel/                        # static, no build step (ST-04)
│   ├── index.html
│   ├── app.js                    # hash router + SSE client + renderers
│   └── style.css                 # dark theme (WP-08)
├── templates/
│   └── project/                  # scaffold copied by create_project
│       ├── lightsout.yaml        # per-project config (§9.1)
│       └── doc/{STATE,PLAN,DECISIONS,QUESTIONS}.md
├── examples/
│   └── agents/                   # sample profiles + policy packs, copied on first boot if agents/ empty
└── scripts/
    ├── login-claude.sh           # docker exec -it … interactive login (RT-04)
    ├── login-codex.sh
    └── install.sh                # host-side bootstrap: checks docker, creates workspace, copies .env
```

Runtime workspace on the host (not in the repo; bind-mounted):

```
$LIGHTSOUT_WORKSPACE/            # e.g. /home/<user>/lightsout-data (WSL2 ext4)
├── agents/
│   ├── policies/                # policy packs (default.yaml, strict.yaml, …)
│   └── *.yaml                   # agent profiles
└── projects/
    └── <project-slug>/          # own git repo, doc/, source
```

## 3. Container and configuration

### 3.1 Dockerfile (RT-01, ST-05)

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/*
# Engine CLIs and ACP adapters. Pin exact versions at implementation time.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
      <claude-acp-adapter-pkg> <codex-acp-adapter-pkg>
RUN useradd -m -u 1000 app
WORKDIR /opt/lightsout
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY panel/ ./panel/
COPY templates/ ./templates/
COPY examples/ ./examples/
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
      - lightsout-workspace:/workspace         # RT-02 default: managed volume
      # - ${LIGHTSOUT_WORKSPACE}:/workspace    # advanced: host bind mount
      # - ${LO_EXPORT_DIR}:/export             # optional, project sync target (SU-06)
      - lightsout-db:/data                     # DB-01
      - claude-auth:/home/app/.claude          # RT-03
      - codex-auth:/home/app/.codex            # RT-03
      # - ${SSH_DIR:-~/.ssh}:/home/app/.ssh:ro # optional, git push (PM-05)
    environment:
      - LO_BIND=0.0.0.0        # container-internal; host binding is 127.0.0.1 above
      - LO_DB=/data/lightsout.db
      - LO_WORKSPACE=/workspace
    env_file: .env
volumes:
  lightsout-db:
  lightsout-workspace:
  claude-auth:
  codex-auth:
```

### 3.3 Outbound network allowlist (RT-05)

Pilot mechanism: an egress HTTP(S) proxy sidecar (tinyproxy) with an allowlist filter; the lightsout service gets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` pointing at it and its network has no default route except the proxy. Both engine CLIs and git honor proxy env vars. Default allowlist: `api.anthropic.com`, `*.claude.ai` (subscription auth), `api.openai.com`, `auth.openai.com` (Codex auth), plus the git remote hosts declared in project configs. The compose file ships with the proxy enabled under a `secure` profile; running without the profile is allowed but the panel health page reports `network: unrestricted` (honest signal, not silent).

### 3.4 Environment variables (single source: `src/config.ts`)

| Var | Default | Purpose |
|---|---|---|
| `LIGHTSOUT_WORKSPACE` | — (optional, host side) | Host path bind-mounted at /workspace; unset means the managed `lightsout-workspace` volume (RT-02) |
| `LO_EXPORT_DIR` | — (optional, host side) | Host folder mounted at /export as the project sync target (SU-06) |
| `LO_PORT` | `8484` | Host port for panel/API/MCP |
| `LO_DB` | `/data/lightsout.db` | SQLite path |
| `LO_MAX_PARALLEL` | `3` | Max concurrent runs across projects (SR-07) |
| `LO_TIMEOUT_QUICK_MIN` | `30` | Hard timeout, quick level (SR-04) |
| `LO_TIMEOUT_FULL_MIN` | `90` | Hard timeout, full level |
| `LO_INACTIVITY_MIN` | `8` | Inactivity watchdog (SR-04) |
| `LO_PERMISSION_WAIT_HOURS` | `24` | Max wait on a human-gated permission before cancel (§8.4) |
| `LO_ADVISOR_CONFIDENCE` | `0.7` | Threshold for auto-continue on second opinion (DO-02) |
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

CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

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

### 5.3 Concurrency and locks (SR-07, OR-08)

- In-memory `Map<projectId, runId>` is the project lock; consistent because there is exactly one process.
- `launch_task`/`launch_chain` against a locked project enqueues (task status stays `queued`) and returns `{queued: true}`.
- A global semaphore caps concurrent runs at `LO_MAX_PARALLEL`.
- Crash consistency: locks are memory-only; on boot, recovery (§11.2) marks any `running`/`waiting_human` runs as `interrupted` before locks are rebuilt, so a stale lock can never survive a restart.

## 6. ACP session runner (SR-01..08)

### 6.1 Adapter processes

One adapter child process per active run, spawned with the project directory as cwd:

```
spawn(LO_ADAPTER_CLAUDE | LO_ADAPTER_CODEX, [], { cwd: project.path, env: scrubbedEnv })
```

`scrubbedEnv` passes only what the adapter needs (PATH, HOME, proxy vars, engine config dirs); no LightsOut secrets (NF-02). Communication is JSON-RPC 2.0 over stdio per the ACP spec: `initialize` handshake (declare client fs/terminal capabilities), then `session/new { cwd, mcpServers: [] }`, then `session/prompt`.

### 6.2 Prompt composition (PM-03)

The prompt for a run is assembled from five blocks, in order:

1. Agent profile `instructions` (AP-01).
2. LightsOut protocol block (constant, versioned): how to report results (§6.4), how to raise a doubt, reminder that permissions are mediated and denials are not failures.
3. Project context: managed section of `STATE.md`, open items of `PLAN.md`, last N entries of `DECISIONS.md` (N=10 default).
4. Task spec (`tasks.spec`) with acceptance criteria and verify command if any.
5. Optional knowledge-base excerpts (PM-06, pilot: whole INDEX only if configured).

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

`project_write · project_read · exec_check · git_local · git_push · deps_install · network · delete · outside_workspace · credentials · publish_external · other`

Classification inputs: ACP tool-call kind (fs read/write, terminal), requested path (inside/outside `project.path`), and command string matched against a matcher table (regex list per class, shipped with defaults, extendable in the pack). Unmatched terminal commands → `other`. Path escapes (`..`, absolute outside workspace, symlink resolution) → `outside_workspace` regardless of command.

### 7.2 Policy pack format (`agents/policies/*.yaml`)

```yaml
id: default
rules:                      # first match wins, evaluated top-down
  - class: project_read     ; verdict: allow
  - class: project_write    ; verdict: allow
  - class: exec_check       ; verdict: allow
  - class: git_local        ; verdict: allow
  - class: deps_install     ; verdict: require_human
  - class: delete           ; verdict: require_human
  - class: git_push         ; verdict: deny        # push is the orchestrator's job (PM-05)
  - class: network          ; verdict: deny
  - class: outside_workspace; verdict: deny
  - class: credentials      ; verdict: require_human
  - class: publish_external ; verdict: require_human
  - class: other            ; verdict: require_human
matchers:
  exec_check:
    - '^(npm|pnpm|yarn) (test|run (test|build|lint|typecheck))\b'
    - '^(node|tsc|eslint|prettier|pytest|go test)\b'
  deps_install:
    - '^(npm|pnpm|yarn) (i|install|add)\b'
```

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

- `create_project`: `git init` if needed, initial commit of the scaffold.
- During a run: wip commit every 10 min if dirty and at run end — `wip(lightsout): <taskId> <ts>`.
- Task ok: consolidated commit `feat: <task title> [lo:<taskId>]` (wips remain in history; squashing is v2).
- Provisional decision: annotated tag `lightsout/cp/<taskId>-<n>` at the pre-decision commit (the v2 rewind target).
- Push: orchestrator-only (`git_push` is `deny` for agents), `push_policy=auto` requires verify green in the same task cycle; `--force` is not implemented at all. Credentials: mounted ssh key or `GIT_TOKEN` via credential helper; never persisted (NF-02).

## 10. MCP server (MC-01..06)

### 10.1 Transport

Primary: streamable HTTP at `POST /mcp` on the same Fastify server (protected only by localhost binding, WP-09). For Claude Desktop stdio configs, `dist/mcp-stdio.js` is a stateless bridge: reads JSON-RPC from stdin, forwards to `http://127.0.0.1:8484/mcp`, streams responses back. Desktop config:

```json
{ "mcpServers": { "lightsout": {
    "command": "docker", "args": ["exec","-i","lightsout","node","dist/mcp-stdio.js"] } } }
```

The bridge holds no state and no DB handle (single-writer preserved, ST-02).

### 10.2 Tool contracts (MC-02)

Uniform envelope: success `{ok:true, …}`; failure `{ok:false, error:{code,message}}`. Codes: `NOT_FOUND`, `INVALID_INPUT`, `PROJECT_LOCKED`, `AUTH_REQUIRED`, `CONFLICT`, `INTERNAL`. All ids are strings. Fields marked `?` optional.

| tool | input | output (`ok:true` +) | notes |
|---|---|---|---|
| `health` | `{}` | `{db, engines:{claude:{installed,auth},codex:{…}}, network, activeRuns, version}` | RT-06 |
| `list_projects` | `{archived?:bool}` | `{projects:[{id,name,status,activeRun?,openDoubts,lastActivity}]}` | |
| `create_project` | `{name, remote?, verify?, push?}` | `{project:{id,path}}` | scaffolds template (PM-01) |
| `project_status` | `{projectId}` | `{project, chain?:{id,title,tasks:[{id,position,title,status,agentId}]}, run?:{id,status,engine,model,elapsedS,inactivityS,lastAction,timeoutS}, doubts:[…], state:{phase,lastDecision,next}}` | one call = full picture (MC-06 polling) |
| `list_agents` | `{}` | `{agents:[{id,name,engine,model,valid,error?}]}` | AP-02 |
| `reload_agents` | `{}` | `{loaded,rejected:[{file,error}]}` | AP-03 |
| `launch_chain` | `{projectId, title, tasks:[{title,spec,agentId,level?,verify?}]}` | `{chainId, taskIds, started:bool, queued:bool}` | fire-and-forget (MC-06) |
| `launch_task` | `{projectId, title, spec, agentId, level?, verify?, chainId?}` | `{taskId, runId?, queued}` | appends to chain if given |
| `abort_run` | `{runId?, chainId?}` | `{aborted:[ids]}` | OR-06 |
| `list_doubts` | `{projectId?, status?:'open'}` | `{doubts:[{id,ref,projectId,taskTitle,kind,context,blocks,options,recommendation,secondOpinion?,ageMin}]}` | Desktop renders options as buttons (MC-03) |
| `answer_doubt` | `{doubtId, choice, note?}` | `{resumed:bool, runId?}` | DO-04; `doubtId` accepts the ulid or the `ref` (`D-3`) when `projectId` context is unambiguous |
| `get_history` | `{projectId?, limit?:20, before?}` | `{runs:[{id,task,engine,model,status,startedAt,durationS,costUsd?,summary}], totals:{byStatus,costUsd}}` | OB-05 |
| `read_doc` | `{projectId, doc:'STATE'\|'PLAN'\|'DECISIONS'\|'QUESTIONS'}` | `{content, updatedAt}` | |
| `write_doc` | `{projectId, doc, content}` | `{written:true}` | rejected if a run is active on the project (`CONFLICT`); scoped to doc/ (MC-04) |
| `consult` | `{projectId?, engine?, question}` | `{answer, engine, model, durationS}` | on-demand advisor (MC-05/DO-06) |

Behavioral notes: `launch_*` returns within ~1 s (run starts async); `project_status` is the polling primitive Desktop uses after launches; every mutating tool emits events so the panel updates in real time without extra wiring.

## 11. Boot, recovery and health (RT-04, RT-06, RT-07)

### 11.1 Boot sequence (`src/index.ts`)

1. Parse config (abort on invalid). 2. Open DB, run migrations. 3. Recovery pass (§11.2). 4. Load agent profiles + policy packs (copy `examples/` on first boot if `agents/` empty). 5. Engine detection: adapters present on PATH + auth probe per engine (cheap CLI status command; result cached 10 min, re-probed on failure). 6. Start HTTP (panel/API/SSE/health/mcp). 7. Rebuild project locks (empty) and resume nothing automatically — interrupted work is surfaced, not silently retried.

### 11.2 Recovery pass

`UPDATE runs SET status='interrupted', exit_reason='container restart' WHERE status IN ('running','waiting_human')` + matching task/chain updates + one `system` event each, including the stored `acp_session` for manual resume. Doubts stay open across restarts (they live in the DB).

### 11.3 Auth expiry mid-run

Adapter auth errors are recognized by the ACP error surface → run `error` with `exit_reason='AUTH_REQUIRED'`, engine health flips to `auth:false`, panel shows it in the attention strip (OB-03), `health` tool reports it, and the fix is the documented `scripts/login-*.sh` (RT-04).

## 12. HTTP API, SSE and panel (WP-01..09)

### 12.1 JSON endpoints (read-only, WP-02)

```
GET /health                          → same shape as the MCP health tool
GET /api/overview                    → projects summary + active runs + open doubts + engine health
GET /api/projects/:id                → same shape as project_status
GET /api/projects/:id/history?limit&before
GET /api/runs/:id/events?after=<id>  → paginated event timeline
```

All handlers are SELECT-only against SQLite (OB-01).

The only mutating HTTP routes outside `/mcp` are the setup and export actions (SU-05),
enumerated here and nowhere else. They never touch chains, tasks, runs or doubts:

```
POST /api/setup/login/:engine        → start the interactive login, returns {flowId}
GET  /api/setup/login/:flowId        → SSE: url, code, progress, final auth state
POST /api/setup/login/:engine/key    → store an API key through the engine CLI (NF-03)
POST /api/setup/examples             → copy examples/agents into the workspace
POST /api/setup/project              → create the first project (same path as create_project)
POST /api/export/project/:id         → zip download, or sync to /export when mounted (SU-06)
```

### 12.2 SSE (`GET /api/stream`) (WP-03)

- Named events: `overview` (debounced 500 ms, whenever anything changes), `run:<runId>` (per-run tail for the open project view), `doubt`.
- Each SSE `id:` is the `events.id` cursor; on reconnect the server replays rows `> Last-Event-ID` before resuming live (no gap, no duplicate).
- Keepalive comment every 15 s; client auto-reconnects with backoff. Target event→screen < 2 s.

### 12.3 Panel structure (ST-04)

Single `index.html`, hash routes: `#/` global (attention strip: open doubts with age, failures, auth problems — OB-03; then active runs, engine health), `#/p/<id>` project (current run card with elapsed/timeout and inactivity bars, chain strip, plan checklist, doc summary, open doubts), `#/p/<id>/history`, `#/health`. Rendering: small vanilla-JS renderers fed by `fetch` + SSE patches; dark theme default (WP-08). The HTML mockup already produced for this project is the visual reference; its static data binds to `/api/overview` and `/api/projects/:id`.

## 13. Build order and verification

| Phase | Delivers | Verifies requirements | Done when |
|---|---|---|---|
| 1 | Image + compose + volumes + login scripts + `/health` | RT-01..06, NF-01/03 | both engines authenticated inside the container; health green |
| 2 | DB layer + migrations + repos | DB-01..03 | schema applied; repos unit-tested |
| 3 | ACP runner for ONE run + policy engine + audit | SR-01..07, PE-01..04 | a real task runs end-to-end on a sample project with permissions mediated |
| 4 | Orchestrator chains + verify gate + git + docs | OR-*, PM-01..05 | a 3-task chain completes unattended |
| 5 | Doubts + advisor auto-continue | DO-01..05, SR-08, PE-06 | a seeded ambiguous task auto-continues on agreement and opens a doubt on disagreement |
| 6 | MCP server + stdio bridge + all tools | MC-01..06 | full flow driven from Claude Desktop only |
| 7 | Panel + SSE | WP-01..08, OB-03 | chain progress visible live in the browser |
| 8 | Published image + first-run wizard | SU-01..08, RT-02/04 | on a clean machine: pull, start, and the whole setup completes in the browser |

Each phase ends with its own verify script under `scripts/verify/` (the project applies its own medicine: green gate before moving on).

## 14. Setup, distribution and first-run onboarding (SU-01..08, phase 8)

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
  -v lightsout-db:/data -v lightsout-workspace:/workspace \
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex \
  ghcr.io/<org>/lightsout:latest
```

Every setting has a working default (DESIGN §3.4), so no `.env` is needed. The compose file
stays for maintainers and for the egress-restricted profile.

### 14.3 First-run wizard (SU-03)

The panel detects "not set up yet" from three facts read from SQLite and the health probe:
engines unauthenticated, workspace `agents/` empty, no projects. It then shows four steps,
each independently repeatable later from `#/health` and `#/settings`:

1. **Connect engines.** One button per engine (§14.4), or a field to paste an API key.
2. **Connect Claude Desktop.** The exact `claude_desktop_config.json` block with a copy
   button, the file path per OS, and a "test connection" indicator that turns green when the
   first MCP call arrives.
3. **Install examples.** Copies `examples/agents` into the workspace (`POST /api/setup/examples`).
4. **First project.** Name, optional git remote, optional verify command; scaffolds through
   the same code path as `create_project` (PM-01).

### 14.4 Login without a terminal (SU-04)

`POST /api/setup/login/:engine` spawns the engine CLI login inside the container and returns
a `flowId`; the panel subscribes to `GET /api/setup/login/:flowId` (SSE) and renders the URL
and code parsed from the CLI output, then the final state from a fresh auth probe.

The callback needs care. Both CLIs bind their loopback listener inside the container, which a
published port cannot reach (the mapping arrives on the container's external interface). A
small TCP forwarder in the orchestrator process listens on the container's non-loopback
address, port 1455, and pipes to `127.0.0.1:1455`; the published port then works. The
forwarder only runs while a login flow is active and needs no new dependency (`node:net`).

### 14.5 Taking projects out of the managed volume (SU-06)

Default storage is the `lightsout-workspace` volume, so nothing has to be configured at
start; the trade-off is that projects are not browsable in the host file manager. Two exits:
`POST /api/export/project/:id` streams a zip to the browser, and when a host folder is
mounted at `/export`, the same call can mirror the project there (`git clone --local` plus
`doc/`, so the history survives). A project with a git remote needs neither: push covers it.

### 14.6 Boundaries (SU-05)

The setup surface is the six routes listed in §12.1 and nothing else. It cannot launch,
abort, answer doubts or write project files outside the scaffold: operational control stays
in MCP (MC-01). All of it is localhost-bound (WP-09), and the pilot builds no auth.

## 15. Open implementation decisions

- Whether `session/load` resume is exposed by both adapters at pin time; if not, functional-doubt resume falls back to "new run with decision context" (already specified) with no design change.
- tinyproxy vs squid for the egress sidecar (feature-equivalent for this allowlist use).
- GHCR organisation/namespace for the published image (phase 8).

Settled during implementation: ACP adapter packages and versions are pinned in the
Dockerfile and recorded in `doc/DECISIONS.md`.
