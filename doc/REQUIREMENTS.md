# LightsOut — Functional Requirements (Pilot)

Status: draft for review
Scope: pilot phase. Control happens only through MCP (Claude Desktop as the front end). The container serves one read-only web page for status, health and history, updated in real time. Engines: Claude Code and Codex, driven over ACP.

Priority levels: MUST (pilot fails without it), SHOULD (build if cheap, else backlog), MAY (optional).

---

## 1. RT — Runtime and container

- RT-01 MUST. One command (`docker compose up`) starts the whole system: orchestrator, MCP endpoint, web panel, database volume.
- RT-02 MUST. Workspace holds `projects/` and `agents/` in a managed Docker volume by default, so a target machine needs no path configuration. A host bind mount is an advanced option set by env var. Projects can be taken out through the panel (SU-06).
- RT-03 MUST. Engine credentials (`~/.claude`, `~/.codex`) persist in a named volume and survive container rebuilds.
- RT-04 MUST. Engine login is completable from the web panel without a terminal (SU-04). Scripts (`docker exec`) remain as a fallback. Missing or expired auth is detected and reported through MCP and the panel; it never fails silently.
- RT-05 MUST. Outbound network is an allowlist (engine APIs, git remotes). Everything else is denied. Configurable.
- RT-06 MUST. `/health` endpoint reports orchestrator, database, engines detected and auth status.
- RT-07 SHOULD. Graceful shutdown: running sessions receive cancel, state is persisted. On restart, orphaned runs are marked `interrupted` with resume info.
- RT-08 MUST. All code, identifiers, docs and commit messages are in English.

## 2. AP — Agent profiles

- AP-01 MUST. Profiles live as YAML files in `agents/`, one per agent: id, display name, engine (`claude` | `codex`), model, reasoning level, system instructions, default policy pack, tags.
- AP-02 MUST. Profiles are validated on load. An invalid profile is rejected with a reason and listed as such via MCP.
- AP-03 MUST. Profile changes are picked up without restarting the container (watcher or explicit reload tool).
- AP-04 SHOULD. Profiles can include shared instruction fragments to avoid duplication.
- AP-05 SHOULD. Profile defaults (model, reasoning, policy) can be overridden per task at launch time.

## 3. SR — ACP session runner

- SR-01 MUST. Sessions are launched over ACP against the official adapters (`claude-agent-acp`, `codex-acp`) via stdio.
- SR-02 MUST. ACP events (messages, tool calls, file edits, permission requests) are streamed and persisted to the database as normalized events in real time.
- SR-03 MUST. Permission requests are answered programmatically by the policy engine. A session is never left waiting on a permission.
- SR-04 MUST. Each run has a hard timeout and an inactivity watchdog, configurable per level and per task. Expiry cancels the session via ACP and sets state `timeout` or `stuck`.
- SR-05 MUST. Session id, token usage, cost (when the engine reports it) and duration are captured per run.
- SR-06 MUST. `cancel(run)` is supported. SHOULD: `resume(run)` where the adapter supports session load.
- SR-07 MUST. One concurrent run per project (project lock). Runs on different projects execute in parallel up to a configurable maximum.
- SR-08 SHOULD. Ephemeral advisory sessions (read-only, cheap model, minimal reasoning) for second opinions.

## 4. PE — Policy engine

- PE-01 MUST. Policies are declarative packs (YAML). Rules map action classes to a verdict: `allow` | `deny` | `require_human`. Action classes at minimum: write inside project, run build/tests/linters, git local, git push, install dependencies, network access, delete files, touch outside project.
- PE-02 MUST. File scope is enforced: writes only inside the active project directory.
- PE-03 MUST. Irreversible or sensitive classes always resolve to `require_human`: deletions not listed in the plan, force push, credential handling, publishing to external systems.
- PE-04 MUST. Every permission decision is logged with rule, verdict, run and timestamp (audit trail).
- PE-05 SHOULD. Per-project policy overrides layered on top of the agent's default pack.
- PE-06 SHOULD. A `provisional` verdict: allow the action, tag the decision, create a git checkpoint. This is the foundation for v2 optimistic execution and rewind.

## 5. OR — Orchestrator and chains

- OR-01 MUST. Task model: id, project, title, prompt/spec, agent profile, level (`quick` | `full`), optional verify command, position in chain (linear order in the pilot).
- OR-02 MUST. Chain execution: when a task ends `ok` (and verify passes if defined), the next task starts automatically. No human prompt between tasks.
- OR-03 MUST. Task states: `queued`, `running`, `ok`, `doubt`, `verify_failed`, `timeout`, `stuck`, `error`, `aborted`, `interrupted`.
- OR-04 MUST. Verify gate: optional per-project command executed inside the container after the task. Non-zero exit sets `verify_failed` and pauses the chain.
- OR-05 MUST. Any failure state pauses the chain and produces recovery info: session id, last checkpoint, suggested resume.
- OR-06 MUST. Abort task and abort chain are available through MCP.
- OR-07 SHOULD. Per-task cost cap when the engine reports cost (time caps already covered by SR-04).
- OR-08 SHOULD. Launching against a locked project queues the task instead of rejecting it.

## 6. DO — Doubts and second opinion

- DO-01 MUST. A doubt is a structured entity: id, project, task, context, what it blocks, options, recommendation, status (`open` | `answered` | `closed`), answer, timestamps. It is mirrored to the project's `QUESTIONS.md`.
- DO-02 MUST. Before a doubt is opened, the orchestrator requests an automatic second opinion from the other engine (advisory, read-only). If both engines agree and the action class is reversible, the choice is recorded as a provisional decision in `DECISIONS.md` and the database, and the chain continues without human input.
- DO-03 MUST. If the engines disagree, confidence is low, or the class is sensitive or irreversible, the doubt opens and the task pauses cleanly.
- DO-04 MUST. `answer_doubt` via MCP writes the answer, moves the decision to `DECISIONS.md`, and resumes the task (same session where the adapter allows it).
- DO-05 MUST. Open doubts are visible through MCP and the panel, with their age.
- DO-06 SHOULD. On-demand consult tool: ask a second opinion from Desktop at any time.

## 7. PM — Projects and memory

- PM-01 MUST. A project is a folder under `projects/` with `doc/` (`STATE.md`, `PLAN.md`, `DECISIONS.md`, `QUESTIONS.md`) and its own git repository. `create_project` scaffolds it from a template.
- PM-02 MUST. The system updates `STATE.md` automatically when a task closes (progress, last decision, next step). It does not depend on agent discipline.
- PM-03 MUST. Every session starts with the project's `doc/` context injected (state, plan, relevant decisions).
- PM-04 MUST. Git per task: wip commits during the run, a consolidated commit on task `ok`, a checkpoint tag on each provisional decision.
- PM-05 MUST. Push policy: local git always allowed; push to the project remote only after a green verify; configurable per project; force push never.
- PM-06 SHOULD. Optional read-only knowledge base mount, injectable as context by relevance.

## 8. MC — MCP server (control interface)

- MC-01 MUST. The MCP server is the single control interface, reachable from Claude Desktop (stdio bridge via `docker exec`, or streamable HTTP).
- MC-02 MUST. Minimum tool set: `list_projects`, `project_status`, `create_project`, `launch_task`, `launch_chain`, `abort_run`, `list_doubts`, `answer_doubt`, `get_history`, `read_doc`, `write_doc`, `list_agents`, `health`.
- MC-03 MUST. Tool responses are compact structured JSON so Desktop can summarize in plain language and render answer buttons for doubts.
- MC-04 MUST. `write_doc` is restricted to files under the project's `doc/`. Everything else is read-only through MCP.
- MC-05 SHOULD. `consult` (second opinion on demand) and `reload_agents`.
- MC-06 MUST. Launches are fire-and-forget: the tool returns a run id immediately; progress is polled with `project_status`.

## 9. DB — Persistence

- DB-01 MUST. SQLite in WAL mode on a container volume. Schema domains: projects, tasks, runs, events, doubts, decisions, permission_audit, costs.
- DB-02 MUST. Append-only `events` table powers the panel timeline and history.
- DB-03 MUST. Data survives restarts. Single writer (the orchestrator process).
- DB-04 SHOULD. Retention config for events; export to JSONL.

## 10. WP — Web panel (read-only)

- WP-01 MUST. Served by the container on a configurable port, with no external runtime dependencies.
- WP-02 MUST. Read-only for all operational data: no endpoint mutates projects, chains, tasks, runs or doubts. The only mutating endpoints are the explicitly listed setup and export actions of the onboarding wizard (SU-05).
- WP-03 MUST. Real-time updates via SSE or WebSocket, under 2 seconds from event to screen, with automatic reconnection.
- WP-04 MUST. Global view: active runs across projects, open doubts, engine and auth health.
- WP-05 MUST. Project view: current run (state, elapsed vs timeout, inactivity vs limit, last action, engine declaration line), chain progress, plan checklist, doc summary, open doubts.
- WP-06 MUST. History view: past runs with state, duration, cost and summary, from the database.
- WP-07 SHOULD. Health page: container, database, engines, disk usage.
- WP-08 SHOULD. Dark theme by default (it is called LightsOut).
- WP-09 MAY. Bound to localhost by default. Exposing it beyond the host is the user's responsibility (reverse proxy); the pilot builds no auth.

## 11. OB — Observability

- OB-01 MUST. SQLite is the single source of truth for all operational information: run and task state transitions, normalized ACP events, permission decisions, doubt lifecycle, decisions, costs, run summaries and error details. The web panel and `get_history` read exclusively from SQLite.
- OB-02 MUST. Any run is fully reconstructable from the database alone: events, decisions, permission audit.
- OB-03 MUST. Status awareness happens through the web panel (no push channel in the pilot). The panel surfaces attention items prominently: open doubts with age, failure states, expired auth.
- OB-04 SHOULD. Structured JSON logs to stdout (`docker logs`), tagged with run and task ids, for container-level diagnostics only (startup, crashes, DB unavailable). Never a data source for the panel or history.
- OB-05 SHOULD. Basic metrics (runs by state, cost per project per day) available through `get_history`, computed from SQLite.

## 12. SU — Setup and distribution

Goal: on a target machine, running LightsOut is "install a container runtime, start the
container, open the panel". Everything else happens in the browser. Building the image
stays a maintainer task.

- SU-01 MUST. A prebuilt multi-architecture image (linux/amd64 + linux/arm64) is published to a public registry (GHCR) with version tags and `latest`. The target machine pulls it; it never clones the repository and never compiles.
- SU-02 MUST. Start is one action with working defaults: a single `docker run` line or a short compose file, no file to edit, no path to choose. Restart policy brings it back automatically after a reboot.
- SU-03 MUST. First-run web wizard covering: engine connection, the Claude Desktop MCP configuration (shown ready to copy, with the file path), creation of the first project, and installation of the example agent profiles and policy packs.
- SU-04 MUST. Engine login completes from the panel: the flow runs inside the container, its URL and code are shown on screen, the OAuth loopback callback reaches the container, and the panel reports live progress until auth is green. Pasting an API key is offered as an alternative (NF-03).
- SU-05 MUST. The mutating surface of the panel is narrow, explicitly enumerated in the design, bound to localhost, and limited to setup and export actions. Operational control stays in MCP.
- SU-06 SHOULD. A project can be taken out of the managed volume from the panel: download as a zip, or sync to a host folder when one is mounted for that purpose.
- SU-07 SHOULD. A Windows quick start is documented against Docker Desktop as the official runtime, noting that larger organisations need a paid subscription and that free alternatives exist.
- SU-08 SHOULD. Updating is `docker pull` plus restart: migrations apply automatically and no manual step is required.

---

## Non-functional

- NF-01 MUST. Fresh install to first run in under 10 minutes on a machine with Docker and WSL2.
- NF-02 MUST. Secrets never stored in the database, logs or git. Env vars and mounted credential volumes only.
- NF-03 MUST. Works with subscription auth (Claude Pro/Max, ChatGPT plans) as well as API keys.
- NF-04 SHOULD. License decided before first public commit (Apache-2.0 suggested).

## Out of scope for the pilot (v2 backlog)

- Task DAG with parallel fan-out inside one project (pilot is a linear chain).
- Optimistic execution with automatic rewind to checkpoints (PE-06 leaves the hook).
- Preference learning from answered doubts.
- Web panel write actions beyond the setup and export surface of SU-05; authentication; multi-user.
- Push notifications of any kind (webhooks, mobile). Status awareness stays on the web panel.
- Browser-based regression testing harness (Playwright).
- Engines beyond Claude Code and Codex.

## Stack proposal

- ST-01. Single language inside the container: TypeScript on Node.js (current LTS). Rationale: the official ACP adapters (`claude-agent-acp`, `codex-acp`) and the ACP reference SDK are TypeScript; both engine CLIs ship as npm packages; the MCP TypeScript SDK is first-party. One runtime covers orchestrator, MCP server, HTTP/SSE and panel serving.
- ST-02. One process: orchestrator + MCP server + HTTP server (panel, SSE, `/health`) run in a single Node process to keep SQLite single-writer trivially true (DB-03).
- ST-03. Key libraries: `@modelcontextprotocol/sdk` (MCP), ACP TypeScript SDK, `better-sqlite3` (synchronous, WAL), Fastify or Hono (HTTP + SSE), `simple-git`, `zod` (YAML/profile validation), `js-yaml`.
- ST-04. Web panel: static HTML/CSS/JS served by the same process, consuming JSON endpoints plus one SSE stream. No frontend build step in the pilot; a framework build (React/Vite) only if the panel outgrows this.
- ST-05. Base image: `node:22-slim` plus `git`. Engine CLIs installed globally in the image; their credential dirs mounted as volumes (RT-03).
