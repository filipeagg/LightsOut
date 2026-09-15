# LightsOut on Windows — quick start

Everything runs inside one container. The only prerequisite is Docker Desktop.

Repository: <https://github.com/filipeagg/LightsOut>

## 1. Install Docker Desktop

```powershell
winget install Docker.DockerDesktop
```

Open it once and leave it running. It starts by itself on later reboots.

## 2. Start LightsOut

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

The image is public and multi-arch, so there is no registry login. Every setting has a working
default; there is no file to edit.

The panel is at <http://127.0.0.1:8484>.

## 3. Connect the engines

From the web wizard: <http://127.0.0.1:8484/setup.html>

Press **Connect** on each engine. The page runs the engine CLI's own login, shows its output
unedited, and gives you the field for whatever it asks for; an API key works too. Claude runs the
work and Codex gives the second opinion before a doubt is opened, so connect both.

Credentials stay in this machine's `claude-auth` and `codex-auth` volumes and survive updates.

## 4. Connect Claude Desktop

Download the extension:
<https://github.com/filipeagg/LightsOut/raw/main/scripts/windows/lightsout.mcpb>

Install it by dragging it onto the Claude Desktop window, or through Settings → Extensions →
Advanced settings → Install Extension… It asks for one setting, the port, and 8484 is the default.
Restart Claude Desktop afterwards.

This is the only supported way to reach a local MCP server. A custom connector URL does not work —
Claude reaches remote MCP servers from Anthropic's cloud, which has no route to your `127.0.0.1` —
and `claude_desktop_config.json` is no longer read by recent builds.

## 5. Check

Ask Claude Desktop: *use the health tool of lightsout*. It should report the database, both engines
authenticated and no active runs. The same picture is at <http://127.0.0.1:8484/health>.

## Updating later

```powershell
docker pull ghcr.io/filipeagg/lightsout:latest
docker rm -f lightsout
```

Then run the command from step 2 again. Migrations run at boot and every volume survives, so
credentials, database and projects are kept. Restart Claude Desktop: it reads the tool list once,
when it connects.

## Worth knowing

- **Your workspace is a folder on your own machine**: `%USERPROFILE%\Documents\LightsOut`. Projects,
  agent profiles, templates and knowledge bases live there, openable in your own editor. Do not
  hand-edit a project while a run is active on it; the panel shows which ones are busy.
- **The extension is only a bridge.** It declares no tools of its own — the container serves the
  tool list when Claude Desktop connects — so it does not have to match the image version.
- **Projects do not travel with the image.** To take one from another machine: clone its
  repository, then use *Adopt existing* and *Import bundle* in the panel. The bundle names the
  credentials it needs but never carries their values, so you set those yourself.
