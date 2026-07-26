# LightsOut — Functional Requirements (Pilot)

Status: draft for review
Scope: pilot phase. Control happens through two equivalent surfaces: MCP (Claude Desktop as the project coordinator) and the web panel, which configures agents, project templates and knowledge, and drives phases. Engines: Claude Code and Codex, driven over ACP.

Priority levels: MUST (pilot fails without it), SHOULD (build if cheap, else backlog), MAY (optional).

---

## 1. RT — Runtime and container

- RT-01 MUST. One command (`docker compose up`) starts the whole system: orchestrator, MCP endpoint, web panel, database volume.
- RT-02 MUST. The workspace holds `projects/`, `agents/`, `templates/` and `knowledge/` on a **host folder bind-mounted into the container**, so every project file is browsable and editable from the user's own machine with no export step. The start action picks a default path (`%USERPROFILE%\Documents\LightsOut` on Windows, `~/LightsOut` elsewhere) and the wizard can change it; a managed volume stays available as a fallback for headless installs. The workspace layout is fixed and created on first boot if absent.
- RT-03 MUST. Engine credentials (`~/.claude`, `~/.codex`) persist in a named volume and survive container rebuilds.
- RT-04 MUST. Engine login is completable from the web panel without a terminal (SU-04). Scripts (`docker exec`) remain as a fallback. Missing or expired auth is detected and reported through MCP and the panel; it never fails silently.
- RT-05 MUST. Outbound network is an allowlist (engine APIs, git remotes). Everything else is denied. Configurable.
- RT-06 MUST. `/health` endpoint reports orchestrator, database, engines detected and auth status.
- RT-07 SHOULD. Graceful shutdown: running sessions receive cancel, state is persisted. On restart, orphaned runs are marked `interrupted` with resume info.
- RT-08 MUST. All code, identifiers, docs and commit messages are in English.

## 2. AP — Agent profiles

- AP-01 MUST. Profiles live as YAML files in `agents/`, one per agent: id, display name, engine (`claude` | `codex`), model, reasoning level, system instructions, default policy pack, tags, `enabled` flag and the deliverable the agent is expected to produce.
- AP-02 MUST. Profiles are validated on load. An invalid profile is rejected with a reason and listed as such via MCP.
- AP-03 MUST. Profile changes are picked up without restarting the container (watcher or explicit reload tool).
- AP-04 SHOULD. Profiles can include shared instruction fragments to avoid duplication.
- AP-05 SHOULD. Profile defaults (model, reasoning, policy) can be overridden per task at launch time.
- AP-06 MUST. Profiles are created and edited from the web panel: engine, model, reasoning level, instructions, policy pack, deliverable, tags, enabled. The panel writes the YAML file; the file stays the source of truth (AP-01) and the watcher (AP-03) picks the change up. Hand-editing a file and editing it in the panel are the same operation.
- AP-07 MUST. A profile can be enabled or disabled without deleting it. A disabled profile cannot be launched and is not offered by any template.
- AP-08 MUST. The panel lists the models and reasoning levels each engine accepts, and validates the combination before writing (AP-02). An unknown model is a rejection with a reason, not a silent failure at launch.

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

- PE-01 MUST. Policies are declarative packs (YAML). Rules map action classes to a verdict: `allow` | `deny` | `require_human`. Action classes at minimum: write inside project, read inside project, run build/tests/linters, git local, git push, install dependencies, network access, delete files, touch outside project, credentials, publish externally, write curated knowledge.
- PE-02 MUST. File scope is enforced: writes only inside the active project directory, plus the one curated knowledge base the project declared writable, if any (KB-05). Writes to agent profiles, templates or the vault are refused unconditionally — an agent cannot reconfigure the system running it.
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
- OR-06 MUST. Abort task and abort chain are available from both control surfaces (MC-02, WP-02).
- OR-07 SHOULD. Per-task cost cap when the engine reports cost (time caps already covered by SR-04).
- OR-08 SHOULD. Launching against a locked project queues the task instead of rejecting it.

## 6. DO — Doubts and second opinion

- DO-01 MUST. A doubt is a structured entity: id, project, task, kind (`functional` | `permission` | `gate`), context, what it blocks, options, recommendation, status (`open` | `answered` | `closed`), answer, timestamps. It is mirrored to the project's `QUESTIONS.md`. A `gate` doubt is how a phase waits for human confirmation (TP-01).
- DO-02 MUST. Before a `functional` doubt is opened, the orchestrator requests an automatic second opinion from the other engine (advisory, read-only). If both engines agree and the action class is reversible, the choice is recorded as a provisional decision in `DECISIONS.md` and the database, and the chain continues without human input.
- DO-03 MUST. If the engines disagree, confidence is low, or the class is sensitive or irreversible, the doubt opens and the task pauses cleanly.
- DO-04 MUST. `answer_doubt`, from either surface, writes the answer, moves the decision to `DECISIONS.md`, and resumes the task (same session where the adapter allows it). Answering a `gate` doubt launches the next phase or stops the chain.
- DO-05 MUST. Open doubts are visible through MCP and the panel, with their age.
- DO-06 SHOULD. On-demand consult tool: ask a second opinion from Desktop at any time.

## 7. PM — Projects and memory

- PM-01 MUST. A project is a folder under `projects/` with `doc/` (`STATE.md`, `PLAN.md`, `DECISIONS.md`, `QUESTIONS.md`) and its own git repository. `create_project` scaffolds it from a template.
- PM-02 MUST. The system updates `STATE.md` automatically when a task closes (progress, last decision, next step). It does not depend on agent discipline.
- PM-03 MUST. Every session starts with the project's `doc/` context injected (state, plan, relevant decisions).
- PM-04 MUST. Git per task: wip commits during the run, a consolidated commit on task `ok`, a checkpoint tag on each provisional decision.
- PM-05 MUST. Push policy: local git always allowed; push to the project remote only after a green verify; configurable per project; force push never.
- PM-06 MUST. Curated knowledge bases are attachable to a project and injected as context. Superseded in detail by section 14 (KB).
- PM-07 MUST. A project records which template it was created from, its phase list and the knowledge bases attached at creation, so its status is explainable without reading its files.
- PM-08 MUST. A project can be retired in two steps, both from the panel and from MCP. Archiving hides it from the lists and refuses new launches while keeping every row and every file; it is reversible. Permanent deletion removes its rows and, unless the caller asks to keep them, its files under the workspace. Neither is allowed while a run is active. Permanent deletion is confirmed by naming the project (WP-11) and is recorded as an event that outlives the project.

## 8. MC — MCP server (control interface)

- MC-01 MUST. The MCP server is one of the two control interfaces (the other is the panel, WP-02), reachable from Claude Desktop (stdio bridge via `docker exec`, or streamable HTTP). Both surfaces call the same orchestrator code; neither has a capability the other lacks except where stated.
- MC-02 MUST. Minimum tool set: `list_projects`, `project_status`, `create_project`, `launch_task`, `launch_chain`, `abort_run`, `list_doubts`, `answer_doubt`, `get_history`, `read_doc`, `write_doc`, `list_agents`, `health`, plus `list_templates`, `launch_phase`, `list_knowledge`, `read_knowledge` and `attach_knowledge`.
- MC-03 MUST. Tool responses are compact structured JSON so Desktop can summarize in plain language and render answer buttons for doubts.
- MC-04 MUST. `write_doc` is restricted to files under the project's `doc/`. Everything else is read-only through MCP.
- MC-05 SHOULD. `consult` (second opinion on demand) and `reload_agents`.
- MC-06 MUST. Launches are fire-and-forget: the tool returns a run id immediately; progress is polled with `project_status`.
- MC-07 MUST. Anything the panel can do, MCP can do: agents, templates, knowledge, projects and phases are all configurable from either surface (WP-02, SU-05). The one exception is writing a credential value, which stays on loopback — a value sent through a tool call would travel through the conversation to get here, and VT-02 says values reach the adapter's environment and nowhere else. An action reachable from one surface and not the other is a defect, not a preference.

## 9. DB — Persistence

- DB-01 MUST. SQLite in WAL mode on a container volume, not on the host workspace. Schema domains: projects, project phases, project knowledge attachments, chains, tasks, runs, events, doubts, decisions, permission audit and vault audit. Cost aggregations are views over runs, not a table.
- DB-02 MUST. Append-only `events` table powers the panel timeline and history.
- DB-03 MUST. Data survives restarts. Single writer (the orchestrator process).
- DB-04 SHOULD. Retention config for events; export to JSONL.

## 10. WP — Web panel

- WP-01 MUST. Served by the container on a configurable port, with no external runtime dependencies.
- WP-02 MUST. The panel is a full control surface: it configures agents (AP-06), templates (TP), knowledge (KB) and the vault (VT), creates projects, launches and aborts phases, and answers doubts. Every mutating route is enumerated in the design, bound to localhost, and implemented as a thin call into the same orchestrator entry point the MCP tool uses — no second code path, no direct writes to operational tables (SU-05).
- WP-03 MUST. Real-time updates via SSE or WebSocket, under 2 seconds from event to screen, with automatic reconnection.
- WP-04 MUST. Global view: active runs across projects, open doubts, engine and auth health.
- WP-05 MUST. Project view: current run (state, elapsed vs timeout, inactivity vs limit, last action, engine declaration line), chain progress, plan checklist, doc summary, open doubts.
- WP-06 MUST. History view: past runs with state, duration, cost and summary, from the database.
- WP-07 SHOULD. Health page: container, database, engines, disk usage.
- WP-08 SHOULD. Dark theme by default (it is called LightsOut).
- WP-09 MUST. Bound to localhost. That is the pilot's only access control, which is why it is a MUST and not a preference: the panel can now launch work and edit configuration (WP-02), so exposing the port is exposing the system. Putting a reverse proxy in front of it is the user's responsibility and their risk; the pilot builds no auth.
- WP-10 MUST. Project list view: every project ever started, with its template, current phase, phase progress (done / in progress / pending), state of the active run, open doubts and last activity. This is the answer to "what is the state of my projects" without opening any of them (TP-06).
- WP-11 MUST. Every destructive panel action (abort, delete an agent or a template, detach knowledge) asks for confirmation naming the object, and is recorded as an event with `actor='panel'` (PE-04 applies to the panel too).

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
- SU-03 MUST. First-run web wizard covering: the workspace folder on the host (RT-02), engine connection, the Claude Desktop MCP configuration (shown ready to copy, with the file path), and creation of the first project from a template. The builtin agents, templates and policy packs need no installation step: they ship inside the image (BA-01, TP-02).
- SU-04 MUST. Engine login completes from the panel: the flow runs inside the container, its URL and code are shown on screen, the OAuth loopback callback reaches the container, and the panel reports live progress until auth is green. Pasting an API key is offered as an alternative (NF-03).
- SU-05 MUST. The mutating surface of the panel is explicitly enumerated in the design (WP-02), bound to localhost, and routed through the same orchestrator entry points as the MCP tools. "Enumerated" is the constraint, not "narrow": nothing mutates operational tables directly and nothing bypasses the policy engine.
- SU-06 SHOULD. With the default host workspace (RT-02) a project is already a folder on the user's machine, so taking it out is opening it. Zip download from the panel stays for the managed-volume fallback and for sharing a snapshot.
- SU-07 MUST. On Windows the only supported runtime is Docker Desktop: no Linux distribution to install, no shell to open, no integration to enable. The virtual machine Docker Desktop manages for itself is an implementation detail the user never sees. Larger organisations need a paid Docker Desktop subscription; that is a licensing decision, not a technical one.
- SU-08 SHOULD. Updating is `docker pull` plus restart: migrations apply automatically and no manual step is required.
- SU-09 MUST. Registering LightsOut in Claude Desktop takes one paste of a URL: the panel shows `http://127.0.0.1:8484/mcp` ready to copy into the app's custom-connector dialog. Recent builds manage MCP servers through connectors and extensions and ignore `claude_desktop_config.json`, so the file must never be the documented path. For builds that still read it, a script patches it while the app is closed (it rewrites that file on exit, so an edit made while it runs is lost) and keeps a backup.
- SU-10 SHOULD. Every user-facing step on Windows is a double-clickable file. Terminals, execution policies and the difference between `cmd` and PowerShell are never part of the instructions.

## 13. TP — Project templates and phases

A template is the recipe for a kind of work: an ordered list of phases, each phase bound to an
agent profile, with its own prompt, deliverable, verify command and gate.

- TP-01 MUST. A template is a YAML file under `templates/`: id, display name, description, and an ordered list of phases. Each phase declares: id, title, the agent profile that runs it, the phase instructions appended to the agent's own, the expected deliverable (path or description), an optional verify command, `optional` (skippable), `repeatable` (can run more than once), and its gate — `auto` (chain continues on ok) or `human` (the phase closes into a doubt so a person confirms before the next one starts).
- TP-02 MUST. Four templates ship builtin, available on a fresh install with no setup step: **quick-prototype**, **full-development**, **knowledge-curation**, **quick-answers**. Their phase lists are specified in the design.
- TP-03 MUST. Templates are validated on load like agent profiles (AP-02): every referenced agent must exist and be enabled, phase ids unique, gates and verify commands well formed. An invalid template is listed with its reason and cannot be used.
- TP-04 MUST. Templates are created, cloned and edited from the panel (WP-02): add, remove and reorder phases, pick the agent per phase, edit the phase instructions. The panel writes YAML into `templates/`; builtins are cloned rather than modified, and a workspace file shadowing a builtin id wins. The editor is a form, one row per phase, with the agent and the gate as selects and the flags as checkboxes: hand-editing serialised structure in a textarea is not an editing surface, it is a place to make a syntax error.
- TP-05 MUST. Creating a project selects a template. The project's phases are materialised as a chain of tasks in the database at creation, so the phase list is stable even if the template changes afterwards (PM-07).
- TP-06 MUST. Phase status is first-class and queryable: for each phase — pending, in progress, done, failed, skipped — with its run, its deliverable and its timestamps. `project_status` and the panel (WP-10) both report the phase list, what is done, what is running and what is pending.
- TP-07 MUST. A phase can be launched, re-launched (when `repeatable`) and skipped (when `optional`) from either surface. A phase whose gate is `human` does not advance the chain until the confirmation doubt is answered.
- TP-08 SHOULD. A project can add an ad-hoc phase not present in its template, bound to any enabled agent, appended or inserted at a position.

## 14. KB — Curated knowledge

Knowledge is what previous work produced and later work should not have to rediscover: how an
existing codebase is put together, how an API behaves, how the organisation does things.

- KB-01 MUST. A knowledge base is a folder under `knowledge/<id>/` with a `knowledge.yaml` manifest (id, display name, kind, description, tags, owner, updated date) and Markdown documents written for an AI to consume. It is version-controlled with the workspace.
- KB-02 MUST. `kind` classifies the base at minimum as `technical`, `functional`, `organisational`, `market` or `other`. A project can attach several bases of different kinds.
- KB-03 MUST. Bases to load are chosen when a project is created, and can be attached or detached later from either surface (`attach_knowledge`, panel). The attachment is recorded on the project (PM-07).
- KB-04 MUST. Attached knowledge is injected into every session of that project as a context block, ahead of the project's own docs, with each document labelled by its base and kind so an agent can tell organisational context from technical fact.
- KB-05 MUST. Knowledge is read-only to agents by default: a phase cannot silently rewrite a shared base. The knowledge-curation template is the one exception, and it writes only into the base it was launched against, declared explicitly at launch.
- KB-06 SHOULD. When the total attached knowledge exceeds a configurable budget, injection is by relevance: the manifests and index of every base always, full documents for the highest-scoring ones, and the rest listed as available on request through a read tool.
- KB-07 MUST. The knowledge-curation template's output is a knowledge base in this format, so the analysis of a project feeds directly into the next project that needs it.
- KB-08 MUST. Bases are created and edited from the panel without touching a file: the manifest is a form, documents are uploaded or written in place, and a base may instead point at a folder already in the workspace, which stays the source of truth and is read on every load. A linked base is never the writable one (KB-05). Documents are text — `.md`, `.markdown`, `.txt` — and anything else is refused with a reason, because a document that cannot be injected is a document the agent is told exists and cannot read.
- KB-09 MUST. A base holds a tree, not a flat list: documents are found in subfolders too, and each one is identified and labelled by its path inside the base (`efemis/tecnico/api.md`), because that path is usually how the person organising the folder said what the document is about.
- KB-10 MUST. Pointing at a folder of documents is enough to start using it. The panel shows the workspace as it really is — every folder, how many documents it holds counting subfolders, and which ones are already bases — and adopting one writes whatever is missing for the system to accept it: a manifest from the form, and an index only if the folder has none. What is already there is reused, never overwritten. A folder that holds documents and no manifest is an invitation, not an error: it is offered for adoption instead of being reported as a rejected base.

- KB-11 MUST. A base declares an **enforcement level**, separate from its `kind`: `advisory` (the default — context the agent should use) or `hard` (rules the agent may not decide against). Hard rules are what a design system, a strict technology directive or a mandatory architectural constraint is: not background, not a preference, and not something an agent settles by judging it reasonable in this case. A base is marked hard when it is created or edited, and the panel shows which of a project's attached bases are hard.
  - KB-11a MUST. Hard rules are injected ahead of every other block, labelled as binding, with the instruction that a decision contradicting one is not the agent's to take: it must end its turn and say which rule it would have to break and why it believes it needs to.
  - KB-11b MUST. Such a declaration opens a doubt of kind `hard_rule` that **only a human can settle**: the advisor is not consulted, agreement cannot substitute for the user, and it does not count against the auto-continue budget. This is the one class of doubt where a second opinion is not wanted — the point of a hard rule is that the decision was already taken and is not being reopened by two models agreeing with each other.
  - KB-11c MUST. A hard-rule base is never the writable one (KB-05), whatever a template declares: an agent that could rewrite the rules it is bound by is not bound by them.
  - KB-11d SHOULD. Enforcement is by instruction and self-report, and the documentation says so plainly: nothing mechanically parses a design system to detect a violation. What the system guarantees is that a violation the agent declares cannot be waved through by anything other than the user.

## 15. VT — Credentials vault

- VT-01 MUST. A vault holds the URLs, credentials and test accounts the probing agent (BA-02) needs: entries of `{id, label, base_url, auth kind, fields, notes, scope}`, grouped by target system.
- VT-02 MUST. The vault is a file in the workspace, git-ignored, never written to SQLite, never printed to logs and never included in an event payload (NF-02). Values reach an agent only as environment variables of the probing process, and only for entries whose scope covers that project.
- VT-03 MUST. The panel edits the vault with write-only value fields: a stored secret is never sent back to the browser, only its presence, label and last-updated date.
- VT-04 MUST. An agent that needs a credential which is absent opens a doubt naming the entry it needs, instead of guessing, hardcoding or failing obscurely.
- VT-05 MUST. Vault reads are audited (PE-04): which run read which entry id, when. Values are never in the audit row.
- VT-06 SHOULD. Entries can be marked `test-only`; a policy pack can refuse any probe against an entry not so marked.

## 16. BA — Builtin agent library

- BA-01 MUST. Ten agent profiles ship inside the image and are available to a new installation with no setup step (SU-03). They are read-only builtins; the panel edits them by cloning into the workspace, where the copy shadows the builtin by id (TP-04 layering). A `docker pull` updates builtins without touching user copies.
- BA-02 MUST. The builtin library covers, at minimum: **prompt-architect** (turns a rough user idea into a complete prompt, asking questions, stating risks bluntly and demanding the missing detail; deliverable: a prompt covering the maximum number of dimensions so another agent can act on it objectively), **contract-prober** (probes an API or integration with real Python scripts and test credentials from the vault before any development depends on it; deliverable: an integration contract precise enough that a developer agent cannot misread it), **planner** (deliverable: an unambiguous software development plan with contracts, specifications and edge cases enumerated), **builder** (senior developer; executes one specific piece of a detailed plan), **coordinator** (owns the project: which phase it is in, answers other agents' doubts, asks the user for what is missing — normally embodied by Claude Desktop), **software-auditor** (audits the delivered code, test coverage and engineering practice; runs at the end of a relevant development phase, not continuously), **qa-engineer** (writes and runs regression and integration tests including a simulated walk through the web interface; deliverable: a test report with results), **codebase-analyst** (analyses an existing project in depth, raises the critical questions it cannot answer alone, and documents how the project works; deliverable: documents in KB format so another agent can modify that project with minimal risk), **answerer** (answers a question against the attached knowledge briefly and without ceremony; the agent behind the quick-answers template), and **reviewer** (the existing code reviewer).
- BA-03 MUST. Each builtin declares its engine, model and reasoning level as a sensible default, and every one of them is overridable per installation, per project and per launch (AP-05, AP-06).
- BA-04 MUST. Each builtin declares its deliverable explicitly, and the phase that runs it fails rather than passing silently when the deliverable is absent.
- BA-05 MUST. Each builtin declares the policy pack it needs, and the pack is what enforces it — not the instructions: `contract-prober` and `qa-engineer` need to execute code and reach the network; `software-auditor`, `prompt-architect` and `planner` are read-and-document only and must not modify source; `codebase-analyst` writes only into the knowledge base its project declared writable; `answerer` writes nothing at all.
- BA-06 SHOULD. A builtin whose engine is unavailable or unauthenticated is listed as such and its phases refuse to launch with that reason (RT-04), rather than starting and failing mid-run.

---

## Non-functional

- NF-01 MUST. Fresh install to first run in under 10 minutes on a machine with Docker Desktop.
- NF-02 MUST. Secrets never stored in the database, logs or git. Env vars and mounted credential volumes only.
- NF-03 MUST. Works with subscription auth (Claude Pro/Max, ChatGPT plans) as well as API keys.
- NF-04 SHOULD. License decided before first public commit (Apache-2.0 suggested).

## Out of scope for the pilot (v2 backlog)

- Task DAG with parallel fan-out inside one project (pilot is a linear chain).
- Optimistic execution with automatic rewind to checkpoints (PE-06 leaves the hook).
- Preference learning from answered doubts.
- Panel authentication and multi-user; the panel assumes a single trusted local user (WP-09).
- Editing a builtin agent or template in place: the panel clones it into the workspace instead (BA-01).
- Automatic relevance scoring beyond the simple tag-and-title heuristic of KB-06.
- Push notifications of any kind (webhooks, mobile). Status awareness stays on the web panel.
- A browser-testing harness built into LightsOut itself. The `qa-engineer` agent (BA-02) sets one up inside the project it is testing, as project code under the project's own dependencies; LightsOut ships no Playwright and drives no browser.
- Engines beyond Claude Code and Codex.

## Stack proposal

- ST-01. Single language inside the container: TypeScript on Node.js (current LTS). Rationale: the official ACP adapters (`claude-agent-acp`, `codex-acp`) and the ACP reference SDK are TypeScript; both engine CLIs ship as npm packages; the MCP TypeScript SDK is first-party. One runtime covers orchestrator, MCP server, HTTP/SSE and panel serving.
- ST-02. One process: orchestrator + MCP server + HTTP server (panel, SSE, `/health`) run in a single Node process to keep SQLite single-writer trivially true (DB-03).
- ST-03. Key libraries: `@modelcontextprotocol/sdk` (MCP), ACP TypeScript SDK, `better-sqlite3` (synchronous, WAL), Fastify or Hono (HTTP + SSE), `simple-git`, `zod` (YAML/profile validation), `js-yaml`.
- ST-04. Web panel: static HTML/CSS/JS served by the same process, consuming JSON endpoints plus one SSE stream. No frontend build step in the pilot; a framework build (React/Vite) only if the panel outgrows this.
- ST-05. Base image: `node:22-slim` plus `git`. Engine CLIs installed globally in the image; their credential dirs mounted as volumes (RT-03).
- ST-06. `contract-prober` (BA-02) probes APIs with Python, so the image adds `python3`, `pip` and `httpx` in a virtualenv at `/opt/probe-venv`. Nothing else in the system needs Python; this is the only reason it is there. Approved 2026-07-25.
