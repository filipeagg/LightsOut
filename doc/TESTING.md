# LightsOut — testing guide (state: phase 4)

What can be exercised today, how to do it, and what counts as a finding. Written for a
separate tester session that does not build the system.

## What exists and what does not

Working: the container with both engines authenticated, the database, agent profiles and
policy packs, a single mediated run, and chains of tasks that execute unattended with git
commits, a verify gate and self-updating project docs.

Not built yet, so not a bug:

- Answering a doubt (phase 5). A doubt is recorded and the chain stops there; there is no way
  to reply to it yet.
- Control from Claude Desktop over MCP (phase 6). Everything is driven from the terminal.
- The web panel beyond `/health` (phase 7). `http://127.0.0.1:8484/` shows a placeholder.
- One-command install and the setup wizard (phase 8).
- The advisor second opinion, provisional decisions and checkpoint tags (phase 5).

## Control interface

The intended way to drive LightsOut is MCP from Claude Desktop: `list_projects`,
`project_status`, `create_project`, `launch_task`, `launch_chain`, `abort_run`, `list_doubts`,
`answer_doubt`, `get_history`, `read_doc`, `write_doc`, `list_agents`, `health`. That server is
phase 6 and does not exist yet, so until it ships the CLIs below are the only way in, and the
terminal stays useful afterwards for what MCP does not expose: files on disk, git history,
container logs, the database, and restarting the container mid-run.

## Prerequisites

Docker Engine must be running inside WSL2 Ubuntu, and the container must be up:

```bash
cd /mnt/c/Users/fcg102006/Desktop/claude/LightsOut
export DOCKER_CONFIG=$HOME/.docker-lo          # Docker Desktop leftovers, see INSTALL.md
docker compose up -d
curl -s localhost:8484/health
```

`/health` must report `"status":"ok"` with both engines `"auth":true`. If an engine says
false, run `./scripts/login-claude.sh` or `./scripts/login-codex.sh` and try again.

## The two ways to run work

One task, no chain, no git, no verify gate:

```bash
docker exec lightsout node dist/cli/run-task.js \
  --project <slug> --agent builder --level quick \
  --title "<short title>" \
  --spec "<full instructions, acceptance criteria included>"
```

A chain of tasks, executed unattended, with commits, verify gate and doc updates:

```bash
docker exec lightsout node dist/cli/run-chain.js \
  --project <slug> --agent builder --level quick \
  --verify "<command that must pass after every task>" \
  --chain "<chain title>" \
  --task "Title 1 :: full spec of task 1" \
  --task "Title 2 :: full spec of task 2"
```

Notes that matter:

- `--verify` runs **after every task**, not only at the end. A command that can only pass
  once the last task is done will fail the chain at task one.
- `--agent` is a profile id from `/workspace/agents/*.yaml`: `builder` (Claude, implements) or
  `reviewer` (Codex, read-only, strict policy).
- `--level quick` uses the 30-minute hard timeout, `full` uses 90; both have an 8-minute
  inactivity watchdog.
- Projects live in the `lightsout-workspace` Docker volume under
  `/workspace/projects/<slug>`, each with its own git repository.

## Looking at what happened

```bash
# state of everything
curl -s localhost:8484/health

# the project tree, docs and git history
docker exec lightsout ls -la /workspace/projects/<slug>
docker exec lightsout cat /workspace/projects/<slug>/doc/STATE.md
docker exec lightsout cat /workspace/projects/<slug>/doc/PLAN.md
docker exec -w /workspace/projects/<slug> lightsout git log --oneline

# the audit trail and event timeline of the last run
docker cp scripts/inspect-run.mjs lightsout:/opt/lightsout/inspect-run.mjs
docker exec -w /opt/lightsout lightsout node inspect-run.mjs

# container logs
docker logs --tail 50 lightsout
```

Everything shown anywhere comes from SQLite, so the database is the place to settle any
disagreement about what happened.

## Scenarios worth running

1. **Real work, small.** Point a chain of two or three tasks at something you actually want
   done in a scratch project. Judge whether the chain needed you.
2. **Verify gate that fails for a real reason.** Set `--verify "npm test"` on a project whose
   tests break. The task must end `verify_failed`, the chain must pause, and the next task
   must never start.
3. **Ambiguous task.** Write a spec with a decision the agent cannot resolve from the
   repository. It should stop and record a doubt with options rather than guess.
4. **Denied permission.** Ask for something the policy denies (install a dependency, reach the
   network, touch a path outside the project). The run should adapt or stop cleanly; the audit
   trail must show the class and the verdict.
5. **Restart mid-run.** `docker restart lightsout` while a task is running. The run must come
   back as `interrupted` with its ACP session recorded, the chain paused, and nothing retried
   silently.
6. **Two projects at once.** Launch chains on two different projects; both should progress.
   Launch two chains on the same project; the second must queue, not fail.
7. **A bad agent profile.** Break one of `/workspace/agents/*.yaml` (invalid engine, unknown
   key). It must be rejected with a reason in the logs while the other profiles keep working.

## What counts as a finding

Report anything in these categories, with evidence:

- The system did something irreversible or outside the project directory.
- A run ended in a state that does not match what actually happened on disk.
- A permission decision that looks wrong: something dangerous allowed, or something harmless
  gated so often that the system is unusable.
- The chain continued after a failure, or stopped when it should have continued.
- Docs (`STATE.md`, `PLAN.md`) disagreeing with the database or with git.
- A crash, a hang, or a run that neither finished nor timed out.
- Anything a non-technical operator would not be able to understand from what is shown.

Useful evidence: the exact command, the JSON the CLI printed, the output of
`inspect-run.mjs`, the relevant `docker logs` lines, and the project's git log.

Cost is real: every run spends tokens from the authenticated subscriptions. Prefer small
specs and `--level quick` while exploring.
