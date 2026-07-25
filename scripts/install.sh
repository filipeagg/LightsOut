#!/usr/bin/env bash
# Host-side bootstrap for maintainers on Linux and macOS (NF-01): checks Docker, creates the
# workspace, builds and starts. Windows users run scripts/windows/Start-LightsOut.ps1 instead.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found. Install Docker Desktop or Docker Engine."
docker info >/dev/null 2>&1 || fail "docker daemon unreachable. Start Docker and try again."
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin not found."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — defaults work as-is."
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# RT-02: the workspace is a managed volume unless a host path was chosen explicitly.
if [ -n "${LIGHTSOUT_WORKSPACE:-}" ]; then
  mkdir -p "$LIGHTSOUT_WORKSPACE/agents/policies" "$LIGHTSOUT_WORKSPACE/projects"
  echo "Workspace: host folder $LIGHTSOUT_WORKSPACE (remember to swap the volume lines in docker-compose.yml)"
else
  echo "Workspace: managed volume lightsout-workspace"
fi

docker compose build
docker compose up -d

echo
echo "Next steps:"
echo "  1. docker exec -it lightsout node dist/cli/login.js claude"
echo "  2. docker exec -it lightsout node dist/cli/login.js codex"
echo "  3. ./scripts/verify/phase1.sh"
echo "  Panel: http://127.0.0.1:${LO_PORT:-8484}/"
echo "  Claude Desktop: install dist/lightsout.mcpb (see extension/README.md)"
