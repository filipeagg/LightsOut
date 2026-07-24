#!/usr/bin/env bash
# One-time interactive login for the Codex engine (RT-04).
# Credentials land in the codex-auth volume mounted at /home/app/.codex (RT-03).
# Note: the Codex device/browser flow prints a URL to open on the host; the
# container port is not published, so use the code-based flow when offered.
set -euo pipefail

CONTAINER="${LO_CONTAINER:-lightsout}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running. Start it first: docker compose up -d" >&2
  exit 1
fi

echo "Starting interactive Codex login inside '$CONTAINER'."
docker exec -it "$CONTAINER" codex login

echo
echo "Login flow finished. Checking health..."
docker exec "$CONTAINER" node dist/healthcheck.js && echo "health: ok"
