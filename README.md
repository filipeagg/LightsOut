# LightsOut

Agent orchestration system: it runs chains of coding-agent sessions (Claude Code, Codex) inside
one container, mediates their permission requests against policy, raises doubts instead of
guessing, asks a second opinion when a doubt is resolvable, and exposes the whole thing over MCP
plus a read-only web panel.

Copyright 2026 Filipe Gomes. Licensed under the Apache License, Version 2.0 (see `LICENSE`).

## Documents

- `doc/INSTALL.md` — full installation guide, including a fresh machine.
- `doc/REQUIREMENTS.md` — what the system must do (requirement IDs).
- `doc/DESIGN.md` — how it is built, section by section.
- `doc/STATE.md` — current phase, last milestone, next step.
- `doc/DECISIONS.md` — non-obvious implementation choices.
- `doc/TESTING.md` — what can be exercised today and how.

## Requirements

- Windows 11 or macOS with Docker Desktop, or Linux with Docker Engine + compose v2.
- A Claude subscription or API key, and a ChatGPT/OpenAI subscription or API key.

## Install

On Windows, double-click the numbered files in `scripts/windows/`:

1. `1-Start-LightsOut.bat` — starts Docker Desktop if needed, builds or pulls, runs the container.
2. `2-Connect-Claude.bat` and `3-Connect-Codex.bat` — one-time engine logins (RT-04).
3. Install `dist/lightsout.mcpb` in Claude Desktop to get the tools (see `extension/README.md`).

Elsewhere:

```bash
cp .env.example .env      # defaults work as-is
./scripts/install.sh      # checks docker, builds, starts
docker exec -it lightsout node dist/cli/login.js claude
docker exec -it lightsout node dist/cli/login.js codex
./scripts/verify/phase1.sh   # must print PHASE 1 GREEN
```

Panel and API: <http://127.0.0.1:8484/> (bound to localhost only).
Health: `curl -s localhost:8484/health`.

Full guide, including installing on another machine: `doc/INSTALL.md`.

## Egress allowlist (RT-05)

By default outbound traffic is unrestricted and `/health` says so
(`network: unrestricted`). To enforce the allowlist, edit `proxy/filter` with your
git remote hosts and start with the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml --profile secure up -d
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The build order and the per-phase verification scripts are defined in `doc/DESIGN.md` §13; each
phase has a gate under `scripts/verify/`. The gates need a shell with `docker` on PATH: on
Windows, Git Bash works.
