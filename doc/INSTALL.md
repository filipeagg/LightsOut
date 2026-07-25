# LightsOut — installation guide

Everything runs inside one container. The host only needs Docker: Node, TypeScript and the engine
CLIs live in the image (NF-01).

> **Two audiences.** The first section is the end-user path: install Docker Desktop, start the
> container, connect the engines, install the Claude Desktop extension. The maintainer section
> below covers building from the repository and running the phase gates.

---

## End-user installation (Windows or macOS)

### 1. Install Docker Desktop

Download it from docker.com, or on Windows:

```powershell
winget install Docker.DockerDesktop
```

Open it once and leave it running; it starts by itself on later reboots. Nothing else has to be
installed and no shell is needed. Large organisations need a paid Docker Desktop subscription —
a licensing question, not a technical one (SU-07).

### 2. Start LightsOut

Double-click `scripts/windows/1-Start-LightsOut.bat`. It finds Docker Desktop, starts it if it is
not running, pulls or builds the image, runs the container with automatic restart, and opens the
panel at <http://127.0.0.1:8484>.

On macOS or Linux, or if you prefer a command:

```bash
docker run -d --name lightsout --restart unless-stopped \
  -p 127.0.0.1:8484:8484 -p 127.0.0.1:1455:1455 \
  -v lightsout-db:/data -v lightsout-workspace:/workspace \
  -v claude-auth:/home/app/.claude -v codex-auth:/home/app/.codex \
  lightsout:local
```

Every setting has a working default (DESIGN §3.4), so there is no file to edit. Projects live in
the `lightsout-workspace` volume (RT-02).

### 3. Connect the engines (once per machine)

Double-click `2-Connect-Claude.bat` and `3-Connect-Codex.bat`. Each prints a URL: open it, approve,
and the script confirms the result by reading `/health`. If your ChatGPT workspace forbids device
codes, use the API key path:

```powershell
.\Connect-Engine.ps1 -Engine codex -ApiKey
```

Elsewhere, the same thing without the wrapper:

```bash
docker exec -it lightsout node dist/cli/login.js claude
docker exec -it lightsout node dist/cli/login.js codex
```

Credentials live in the `claude-auth` and `codex-auth` volumes and survive rebuilds (RT-03). The
OAuth callback reaches the container through the published 1455 port and an internal forwarder, so
no extra networking is needed.

### 4. Connect Claude Desktop

Install the extension `dist/lightsout.mcpb`: double-click it, drag it onto the Claude Desktop
window, or use Settings → Extensions → Advanced settings → Install Extension…

That is the only supported way to reach a local MCP server. A custom connector URL will not work:
Claude reaches remote MCP servers from Anthropic's cloud, which has no route to your `127.0.0.1`.
Editing `claude_desktop_config.json` will not work either — recent builds never read it. See
`extension/README.md`.

### 5. Check

Ask Claude Desktop: *use the health tool of lightsout*. It should report the database, both engines
authenticated, and no active runs. The same picture is at <http://127.0.0.1:8484/health>.

### Updating

```powershell
docker pull <image>
docker rm -f lightsout
```

then start again. Migrations run at boot and every volume survives, so credentials, database and
projects are kept (SU-08).

---

## Maintainer installation (from the repository)

Requirements: Docker (Desktop or Engine) with compose v2, and a shell. On Windows the phase gates
are bash scripts, so use Git Bash with `docker` on PATH.

```bash
git clone <remote> lightsout && cd lightsout
cp .env.example .env          # defaults work as-is
./scripts/install.sh          # checks docker, builds, starts
```

Then the two logins above, and:

```bash
./scripts/verify/phase1.sh    # must print PHASE 1 GREEN
```

To rebuild the Claude Desktop extension after changing `extension/`:

```powershell
.\scripts\windows\Build-Extension.ps1     # writes dist/lightsout.mcpb
```

Only if you want projects in a host folder instead of the managed volume: set
`LIGHTSOUT_WORKSPACE` and swap the two workspace volume lines in `docker-compose.yml`. Prefer a
native Linux path; a mounted Windows drive is several times slower for git and file I/O.

## Optional: enforce the egress allowlist (RT-05)

By default outbound traffic is unrestricted and `/health` reports `network: unrestricted`. To
restrict it, add your git remote hosts to `proxy/filter`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml --profile secure up -d
```

## What is per-machine and is never copied

- `.env` — ignored by git, written per machine.
- Engine credentials — in Docker volumes; every machine does its own login.
- The SQLite database — a Docker volume; it is that machine's history.
- The workspace volume (`projects/`, `agents/`) — share projects through their git remotes
  (PM-05), not by copying volumes. From phase 8 the panel can also export a project as a zip or
  sync it to a host folder (SU-06).
- Agent profiles and policy packs live in the workspace, not in the repo. A fresh machine starts
  from `examples/agents/`, copied on first boot when `agents/` is empty. Keep tuned profiles in
  their own repository if you want them on several machines.

## Troubleshooting

- **A `.ps1` opens in a text editor.** It was launched from `cmd`, where PowerShell scripts are not
  executable. Use the numbered `.bat` files; they set the execution policy themselves.
- **`docker` reports no daemon.** Docker Desktop is installed but not started. Open it once, or let
  `1-Start-LightsOut.bat` start it for you. A stray `docker.exe` from an old install can also sit on
  PATH and reach nothing.
- **The extension file has no application associated.** Windows has no handler for `.mcpb` until
  Claude Desktop registers one. Install it from Settings → Extensions → Advanced settings instead,
  and switch the file dialog to "All files" if the filter hides it.
- **A login page ends blank.** The callback needs the published 1455 port. Use the connect scripts,
  which run the login inside the container with the forwarder in place, rather than calling the
  engine CLI by hand.
- **A run seems stuck for hours.** A permission the policy sends to a human parks the run for up to
  `LO_PERMISSION_WAIT_HOURS` (24 by default). That is by design: answer the doubt with
  `answer_doubt` and it continues where it stopped.
