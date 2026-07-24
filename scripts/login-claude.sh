#!/usr/bin/env bash
# One-time interactive login for the Claude engine (RT-04).
# Credentials land in the claude-auth volume mounted at /home/app/.claude (RT-03),
# so they survive container rebuilds. Works with subscription plans and API keys (NF-03).
set -euo pipefail

CONTAINER="${LO_CONTAINER:-lightsout}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running. Start it first: docker compose up -d" >&2
  exit 1
fi

echo "Starting interactive Claude login inside '$CONTAINER'."
echo "Follow the prompts; then verify with: curl -s localhost:\${LO_PORT:-8484}/health"
docker exec -it "$CONTAINER" claude /login

echo
echo "Login flow finished. Checking health..."
docker exec "$CONTAINER" node dist/healthcheck.js && echo "health: ok"
