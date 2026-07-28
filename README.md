# LightsOut

Agent orchestration system: it runs chains of coding-agent sessions (Claude Code, Codex) inside
one container, mediates their permission requests against policy, raises doubts instead of
guessing, asks a second opinion when a doubt is resolvable, and exposes the whole thing over MCP
plus a read-only web panel.

Copyright 2026 [Filipe Gomes](https://www.linkedin.com/in/filipeagg/). Licensed under the Apache
License, Version 2.0 with the Commons Clause condition (see `LICENSE`): free to use, modify and
redistribute, including commercially inside your own organisation; not for sale or resale, as
itself or as a service, by anyone but the Licensor.

## Documents

- `doc/INSTALL.md` — full installation guide, including a fresh machine.
- `doc/EXAMPLES.md` — realistic usage walkthroughs.
- `doc/REQUIREMENTS.md` — what the system must do (requirement IDs).
- `doc/DESIGN.md` — how it is built, section by section.
- `doc/STATE.md` — current phase, last milestone, next step.
- `doc/DECISIONS.md` — non-obvious implementation choices.
- `doc/TESTING.md` — what can be exercised today and how.

## Requirements

- Windows 11 or macOS with Docker Desktop, or Linux with Docker Engine + compose v2.
- A Claude subscription or API key, and a ChatGPT/OpenAI subscription or API key.

## Install

```bash
docker run -d --name lightsout --restart unless-stopped \
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 \
  -v lightsout-db:/data \
  -v "$HOME/LightsOut:/workspace" \
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex \
  ghcr.io/<owner>/lightsout:latest
```

Open <http://127.0.0.1:8484/> — the first-run wizard walks through connecting the engines,
Claude Desktop and your first project. Install `dist/lightsout.mcpb` in Claude Desktop to get the
tools (see `extension/README.md`).

Panel and API are bound to localhost only. Health: `curl -s localhost:8484/health`.

Platform-specific detail — Windows double-click entry points, building from source instead of
pulling, the egress allowlist, updating — is in `doc/INSTALL.md`.

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
