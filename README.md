# LightsOut

Agent orchestration system: it runs chains of coding-agent sessions (Claude Code, Codex) inside
one container, mediates their permission requests against policy, raises doubts instead of
guessing, asks a second opinion when a doubt is resolvable, and exposes the whole thing over MCP
plus a web panel.

Everything runs inside a single container. The only prerequisite is Docker.

---

## Quick start

### 1. Install Docker

**Windows** — Docker Desktop. Open it once and leave it running; it starts by itself on later
reboots.

```powershell
winget install Docker.DockerDesktop
```

**macOS** — Docker Desktop (`brew install --cask docker`).
**Linux** — Docker Engine with compose v2, from your distribution's packages.

### 2. Start LightsOut

**Windows (PowerShell):**

```powershell
docker run -d --name lightsout --restart unless-stopped `
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 -p 127.0.0.1:5170-5189:5170-5189 `
  -v lightsout-db:/data `
  -v "$env:USERPROFILE\Documents\LightsOut:/workspace" `
  -v lightsout-toolchains:/toolchains `
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex `
  -e LO_WORKSPACE_MODE=host -e LO_WORKSPACE_HOST="$env:USERPROFILE\Documents\LightsOut" `
  ghcr.io/filipeagg/lightsout:latest
```

**macOS / Linux (bash):**

```bash
docker run -d --name lightsout --restart unless-stopped \
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 -p 127.0.0.1:5170-5189:5170-5189 \
  -v lightsout-db:/data \
  -v "$HOME/LightsOut:/workspace" \
  -v lightsout-toolchains:/toolchains \
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex \
  -e LO_WORKSPACE_MODE=host -e LO_WORKSPACE_HOST="$HOME/LightsOut" \
  ghcr.io/filipeagg/lightsout:latest
```

The image is public and multi-arch, so there is no registry login. Every setting has a working
default; there is no file to edit.

The panel is at <http://127.0.0.1:8484>. Panel and API are bound to localhost only.

Port 1455 is the OAuth callback the engine CLIs use when you sign in; 5170–5189 is the pool the
preview server hands out, so a project you are building can be opened in your own browser.

### 3. Connect the engines

Open the web wizard: <http://127.0.0.1:8484/setup.html>

Press **Connect** on each engine. The page runs the engine CLI's own login, shows its output
unedited, and gives you the field for whatever it asks for; an API key works too. Claude runs the
work and Codex gives the second opinion before a doubt is opened, so connect both.

Credentials stay in this machine's `claude-auth` and `codex-auth` volumes and survive updates.

### 4. Connect Claude Desktop

Download the extension:
<https://github.com/filipeagg/LightsOut/raw/main/scripts/windows/lightsout.mcpb>

Install it by dragging it onto the Claude Desktop window, or through Settings → Extensions →
Advanced settings → Install Extension… It asks for one setting, the port, and 8484 is the
default. Restart Claude Desktop afterwards.

This is the only supported way to reach a local MCP server. A custom connector URL does not work —
Claude reaches remote MCP servers from Anthropic's cloud, which has no route to your `127.0.0.1` —
and `claude_desktop_config.json` is no longer read by recent builds.

### 5. Check

Ask Claude Desktop: *use the health tool of lightsout*. It should report the database, both
engines authenticated and no active runs. The same picture is at
<http://127.0.0.1:8484/health>, or `curl -s localhost:8484/health`.

---

## Updating

```bash
docker pull ghcr.io/filipeagg/lightsout:latest
docker rm -f lightsout
```

Then run the command from step 2 again. Migrations run at boot and every volume survives, so
credentials, database and projects are kept. Restart Claude Desktop: it reads the tool list once,
when it connects.

## Worth knowing

- **Your workspace is a folder on your own machine** — `%USERPROFILE%\Documents\LightsOut` on
  Windows, `~/LightsOut` elsewhere. Projects, agent profiles, templates and knowledge bases live
  there, openable in your own editor. Do not hand-edit a project while a run is active on it; the
  panel shows which ones are busy.
- **The extension is only a bridge.** It declares no tools of its own — the container serves the
  tool list when Claude Desktop connects — so it does not have to match the image version.
- **Projects do not travel with the image.** To take one from another machine: clone its
  repository and use *Adopt existing*, or import the `.lobundle` its owner exported. A bundle
  carries what git cannot — knowledge bases, agent profiles, the template — and names the
  credentials it needs without ever carrying their values, so you fill those in yourself. When the
  project has no git remote at all, the bundle carries the repository too, as a `git bundle`, and
  the import unpacks it for you. The answer to `import_bundle` tells you what is left to do.

## Documents

- `doc/QUICKSTART-WINDOWS.md` — the steps above, Windows only, nothing else.
- `doc/INSTALL.md` — full installation guide, including a fresh machine.
- `doc/EXAMPLES.md` — realistic usage walkthroughs.
- `doc/REQUIREMENTS.md` — what the system must do (requirement IDs).
- `doc/DESIGN.md` — how it is built, section by section.
- `doc/TESTING.md` — what can be exercised today and how.

## Requirements

- Windows 11 or macOS with Docker Desktop, or Linux with Docker Engine + compose v2.
- A Claude subscription or API key, and a ChatGPT/OpenAI subscription or API key.

## Egress allowlist (RT-05)

By default outbound traffic is unrestricted and `/health` says so (`network: unrestricted`). To
enforce the allowlist, edit `proxy/filter` with your git remote hosts and start with the overlay:

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

## Licence

Copyright 2026 [Filipe Gomes](https://www.linkedin.com/in/filipeagg/). Licensed under the Apache
License, Version 2.0 with the Commons Clause condition (see `LICENSE`): free to use, modify and
redistribute, including commercially inside your own organisation; not for sale or resale, as
itself or as a service, by anyone but the Licensor.
