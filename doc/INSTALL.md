# LightsOut — installation guide

Everything runs inside one container. The host only needs Docker: Node, TypeScript and
the engine CLIs live in the image (NF-01).

> **Two audiences.** This guide is the maintainer path: clone the repository, build the
> image, run the phase gates. From phase 8 on there is a second, much shorter path for end
> users — install Docker Desktop, run one `docker run` line against the published image, and
> complete the rest in the browser (SU-01..08, DESIGN §14). Until phase 8 ships, use the
> maintainer path below.

## 1. Prerequisites

- Windows 11 with WSL2 (Ubuntu 22.04 or newer), or plain Linux.
- Docker Engine + compose v2 **inside WSL2**. Docker Desktop is not required and its
  leftovers actively get in the way (see Troubleshooting).
- A Claude subscription or Anthropic API key, and a ChatGPT subscription or OpenAI API key.

Docker Engine on Ubuntu, if absent:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Then close the shell, run `wsl --shutdown` from PowerShell, and reopen it so the `docker`
group applies. `docker info` must work without sudo before continuing.

## 2. Get the code and configure

```bash
git clone <remote> lightsout && cd lightsout     # or copy the folder
cp .env.example .env
```

Nothing has to be edited: every setting has a working default (DESIGN §3.4) and projects
live in the managed `lightsout-workspace` volume (RT-02).

Only if you want projects in a host folder instead: set `LIGHTSOUT_WORKSPACE` to a **WSL2
ext4 path** such as `/home/<user>/lightsout-data` and swap the two workspace volume lines in
`docker-compose.yml`. A `/mnt/c/...` path works but is several times slower for git and
file I/O.

## 3. Build and start

```bash
./scripts/install.sh
```

It checks Docker, creates `agents/` and `projects/` in the workspace, builds the image
(~5 minutes the first time) and starts the stack. The equivalent manual commands are
`docker compose build` and `docker compose up -d`.

## 4. Authenticate the engines (once per machine)

```bash
./scripts/login-claude.sh      # or --console for API billing, --token for a long-lived token
./scripts/login-codex.sh       # or --api-key with OPENAI_API_KEY set
```

Each script runs the OAuth flow in a throwaway container that shares the host network and
mounts only that engine's credential volume, so the browser callback on `localhost` works
while the long-lived container keeps its isolated network. Credentials live in the
`claude-auth` and `codex-auth` volumes and survive rebuilds (RT-03).

If your ChatGPT workspace has device-code auth disabled by policy, use the default browser
flow (or `--api-key`); `--device-auth` will be rejected by the identity provider.

## 5. Connect Claude Desktop (MCP)

LightsOut is controlled through MCP. Add this to `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), then restart
Claude Desktop:

**The short path, and the one to prefer:** in Claude Desktop open Settings, go to Connectors, add
a custom connector and paste this URL, with no authentication:

```
http://127.0.0.1:8484/mcp
```

Recent Claude Desktop builds manage MCP servers through connectors and extensions and ignore
`claude_desktop_config.json` entirely — editing that file does nothing on those versions. The URL
connector also needs no bridge process and no `docker exec`.

The rest of this section is the fallback for builds that do read the config file.

On Linux or macOS, where `docker` is on the host PATH:

```json
{
  "mcpServers": {
    "lightsout": {
      "command": "docker",
      "args": ["exec", "-i", "lightsout", "node", "dist/mcp/stdio-bridge.js"]
    }
  }
}
```

On Windows with Docker Engine inside WSL2 the host has no working `docker` command, so the call
goes through `wsl.exe`. A leftover `docker.exe` from an old Docker Desktop install may exist on
PATH and silently reach no daemon, which looks exactly like a broken MCP server:

```json
{
  "mcpServers": {
    "lightsout": {
      "command": "wsl.exe",
      "args": [
        "-d", "Ubuntu", "--",
        "docker", "exec", "-i", "lightsout", "node", "dist/mcp/stdio-bridge.js"
      ]
    }
  }
}
```

Check the pipeline before restarting Claude Desktop; it must answer with `serverInfo`:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"d","version":"0"}}}' |
  wsl.exe -d Ubuntu -- docker exec -i lightsout node dist/mcp/stdio-bridge.js
```

The bridge holds no state: it forwards JSON-RPC to the container's `/mcp` endpoint, which is
also reachable directly at `http://127.0.0.1:8484/mcp` for clients that speak streamable HTTP.

Fifteen tools are exposed: `health`, `list_projects`, `create_project`, `project_status`,
`list_agents`, `reload_agents`, `launch_chain`, `launch_task`, `abort_run`, `list_doubts`,
`answer_doubt`, `get_history`, `read_doc`, `write_doc`, `consult`. Ask Claude Desktop for
`health` first: it should report both engines authenticated.

## 6. Verify

```bash
./scripts/verify/phase1.sh
```

Must print `PHASE 1 GREEN`. Panel and API: <http://127.0.0.1:8484/> (localhost only).
Health JSON: `curl -s localhost:8484/health`.

## 7. Optional: enforce the egress allowlist (RT-05)

By default outbound traffic is unrestricted and `/health` reports
`network: unrestricted`. To restrict it, add your git remote hosts to `proxy/filter`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.secure.yml --profile secure up -d
```

## What is per-machine and is never copied

- `.env` — ignored by git, written per machine.
- Engine credentials — in Docker volumes; every machine does its own login.
- The SQLite database — a Docker volume; it is that machine's history.
- The workspace volume (`projects/`, `agents/`) — share projects through their git remotes
  (PM-05), not by copying volumes. From phase 8 the panel can also export a project as a zip
  or sync it to a host folder (SU-06).
- Agent profiles and policy packs live in the workspace, not in the repo. A fresh machine
  starts from `examples/agents/`, copied on first boot when `agents/` is empty. Keep tuned
  profiles in their own repository if you want them on several machines.

## Troubleshooting (WSL2)

- **All network hangs inside WSL while Windows works.** A host firewall is dropping the
  WSL NAT traffic (seen with Panda Adaptive Defense 360). Create `%USERPROFILE%\.wslconfig`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  dnsTunneling=true
  autoProxy=true
  ```

  Then `wsl --shutdown` from PowerShell.

- **`error getting credentials … docker-credential-desktop.exe: exec format error`.** A
  Docker Desktop leftover in `~/.docker/config.json` (`credsStore`) plus symlinks into the
  Windows `.docker` folder. Use a clean config dir:

  ```bash
  mkdir -p ~/.docker-lo && echo '{}' > ~/.docker-lo/config.json
  export DOCKER_CONFIG=$HOME/.docker-lo
  ```

- **`docker` resolves but the socket is missing.** `/usr/bin/docker` is a dead symlink into
  `/mnt/wsl/docker-desktop/...`; remove it and reinstall `docker-ce-cli`.

- **A login page ends blank or with a broken icon.** The engine's login server was reached
  through a published port instead of the host network. Use `scripts/login-*.sh`, which
  already handle this; do not run `docker exec … login` directly.
