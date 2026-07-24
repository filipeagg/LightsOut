#!/usr/bin/env bash
# Host-side bootstrap (NF-01): checks Docker, creates the workspace, copies .env.
# Run from the repository root inside WSL2.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found. Install Docker Engine inside WSL2."
docker info >/dev/null 2>&1 || fail "docker daemon unreachable. Start it: sudo service docker start"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin not found."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — defaults work as-is."
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# RT-02: the workspace is a managed volume unless a host path was chosen explicitly.
if [ -n "${LIGHTSOUT_WORKSPACE:-}" ]; then
  case "$LIGHTSOUT_WORKSPACE" in
    /mnt/c/*) echo "WARNING: workspace on /mnt/c is slow; a WSL2 ext4 path is recommended." ;;
  esac
  mkdir -p "$LIGHTSOUT_WORKSPACE/agents/policies" "$LIGHTSOUT_WORKSPACE/projects"
  echo "Workspace: host folder $LIGHTSOUT_WORKSPACE (remember to swap the volume lines in docker-compose.yml)"
else
  echo "Workspace: managed volume lightsout-workspace"
fi

docker compose build
docker compose up -d

echo
echo "Next steps:"
echo "  1. ./scripts/login-claude.sh"
echo "  2. ./scripts/login-codex.sh"
echo "  3. ./scripts/verify/phase1.sh"
echo "  Panel: http://127.0.0.1:${LO_PORT:-8484}/"
