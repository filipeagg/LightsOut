# LightsOut

Agent orchestration system: it runs chains of coding-agent sessions (Claude Code,
Codex) inside one container, mediates their permission requests against policy,
raises doubts instead of guessing, asks a second opinion when a doubt is
resolvable, and exposes the whole thing over MCP plus a read-only web panel.

Copyright 2026 Filipe Gomes. Licensed under the Apache License, Version 2.0 (see `LICENSE`).

## Documents

- `doc/REQUIREMENTS.md` — what the system must do (requirement IDs).
- `doc/DESIGN.md` — how it is built, section by section.
- `doc/STATE.md` — current phase, last milestone, next step.
- `doc/DECISIONS.md` — non-obvious implementation choices.

## Requirements

- Windows 11 with WSL2 (Ubuntu) or Linux.
- Docker Engine + compose v2 **inside WSL2** (Docker Desktop not required).
- A Claude subscription/API key and a ChatGPT/OpenAI subscription/API key.

## Install

```bash
cp .env.example .env
# edit LIGHTSOUT_WORKSPACE (use a WSL2 ext4 path, not /mnt/c)
./scripts/install.sh          # checks docker, creates workspace, builds, starts
./scripts/login-claude.sh     # one-time interactive login (RT-04)
./scripts/login-codex.sh
./scripts/verify/phase1.sh    # must print PHASE 1 GREEN
```

Panel and API: <http://127.0.0.1:8484/> (bound to localhost only).
Health: `curl -s localhost:8484/health`.

## Egress allowlist (RT-05)

By default outbound traffic is unrestricted and `/health` says so
(`network: unrestricted`). To enforce the allowlist, edit `proxy/filter` with your
git remote hosts and start with the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml --profile secure up -d
```

## Troubleshooting (WSL2)

- **Everything network hangs inside WSL but works on Windows.** A host firewall may be
  dropping the WSL NAT traffic. Create `%USERPROFILE%\.wslconfig` with
  `[wsl2]` / `networkingMode=mirrored` / `dnsTunneling=true` / `autoProxy=true`, then
  `wsl --shutdown`.
- **`error getting credentials … docker-credential-desktop.exe: exec format error`.** A
  leftover Docker Desktop config in `~/.docker` (a `credsStore` entry plus symlinks to the
  Windows `.docker` folder). Use a clean config dir: `export DOCKER_CONFIG=$HOME/.docker-lo`
  (create it with `{}` inside `config.json`).
- **`docker` resolves but the socket is missing.** `/usr/bin/docker` may be a dead symlink
  into `/mnt/wsl/docker-desktop/...`; remove it and reinstall `docker-ce-cli`.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

The build order and the per-phase verification scripts are defined in
`doc/DESIGN.md` §13; each phase has a gate under `scripts/verify/`.
