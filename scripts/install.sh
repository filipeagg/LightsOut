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
  echo "Created .env from .env.example — edit LIGHTSOUT_WORKSPACE before continuing."
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

[ -n "${LIGHTSOUT_WORKSPACE:-}" ] || fail "LIGHTSOUT_WORKSPACE is not set in .env"
case "$LIGHTSOUT_WORKSPACE" in
  /mnt/c/*) echo "WARNING: workspace on /mnt/c is slow; a WSL2 ext4 path is recommended (RT-02)." ;;
esac

mkdir -p "$LIGHTSOUT_WORKSPACE/agents/policies" "$LIGHTSOUT_WORKSPACE/projects"
echo "Workspace ready at $LIGHTSOUT_WORKSPACE"

docker compose build
docker compose up -d

echo
echo "Next steps:"
echo "  1. ./scripts/login-claude.sh"
echo "  2. ./scripts/login-codex.sh"
echo "  3. ./scripts/verify/phase1.sh"
echo "  Panel: http://127.0.0.1:${LO_PORT:-8484}/"
