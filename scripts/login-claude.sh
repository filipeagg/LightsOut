#!/usr/bin/env bash
# One-time interactive login for the Claude engine (RT-04).
# Credentials land in the claude-auth volume mounted at /home/app/.claude (RT-03),
# so they survive container rebuilds. Works with subscription plans and API keys (NF-03).
#
# Usage:
#   ./scripts/login-claude.sh              # Claude subscription (default)
#   ./scripts/login-claude.sh --console    # Anthropic Console / API billing
set -euo pipefail

CONTAINER="${LO_CONTAINER:-lightsout}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running. Start it first: docker compose up -d" >&2
  exit 1
fi

echo "Starting interactive Claude login inside '$CONTAINER'."
echo "The CLI prints a URL: open it on the host, then paste the code back here."
docker exec -it "$CONTAINER" claude auth login "${@:---claudeai}"

echo
docker exec "$CONTAINER" claude auth status || true
echo "Verify with: curl -s localhost:${LO_PORT:-8484}/health"
