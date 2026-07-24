#!/usr/bin/env bash
# One-time interactive login for the Codex engine (RT-04).
# Credentials land in the codex-auth volume mounted at /home/app/.codex (RT-03).
#
# Two paths:
#   ./scripts/login-codex.sh                 # ChatGPT subscription (browser flow)
#   OPENAI_API_KEY=sk-... ./scripts/login-codex.sh --api-key
#
# The browser flow completes on a loopback callback (port 1455) inside the
# container. Publish it first by uncommenting the auth-callback port in
# docker-compose.yml and re-running `docker compose up -d`; otherwise use --api-key.
set -euo pipefail

CONTAINER="${LO_CONTAINER:-lightsout}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running. Start it first: docker compose up -d" >&2
  exit 1
fi

if [ "${1:-}" = "--api-key" ]; then
  : "${OPENAI_API_KEY:?set OPENAI_API_KEY in the environment first}"
  printf '%s' "$OPENAI_API_KEY" | docker exec -i "$CONTAINER" codex login --with-api-key
else
  if ! docker port "$CONTAINER" 1455 >/dev/null 2>&1; then
    echo "WARNING: port 1455 is not published, so the browser callback cannot reach the"
    echo "container. Uncomment the auth-callback port in docker-compose.yml and re-run"
    echo "'docker compose up -d', or use: OPENAI_API_KEY=... $0 --api-key"
    echo
  fi
  echo "Starting interactive Codex login inside '$CONTAINER'."
  docker exec -it "$CONTAINER" codex login
fi

echo
docker exec "$CONTAINER" codex login status || true
echo "Verify with: curl -s localhost:${LO_PORT:-8484}/health"
