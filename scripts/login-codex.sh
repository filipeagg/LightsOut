#!/usr/bin/env bash
# One-time interactive login for the Codex engine (RT-04).
# Credentials land in the codex-auth volume mounted at /home/app/.codex (RT-03).
#
# Default: device authorization. The CLI prints a URL and a code; you open the URL
# on the host and type the code. Nothing has to reach the container, which is what
# a headless container needs.
#
# Alternatives:
#   OPENAI_API_KEY=sk-... ./scripts/login-codex.sh --api-key   # API billing (NF-03)
#   ./scripts/login-codex.sh --browser                         # local callback flow;
#       requires the 1455 port published (see docker-compose.yml)
set -euo pipefail

CONTAINER="${LO_CONTAINER:-lightsout}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running. Start it first: docker compose up -d" >&2
  exit 1
fi

case "${1:-}" in
  --api-key)
    : "${OPENAI_API_KEY:?set OPENAI_API_KEY in the environment first}"
    printf '%s' "$OPENAI_API_KEY" | docker exec -i "$CONTAINER" codex login --with-api-key
    ;;
  --browser)
    if ! docker port "$CONTAINER" 1455 >/dev/null 2>&1; then
      echo "Port 1455 is not published: the browser callback cannot reach the container." >&2
      echo "Uncomment the auth-callback port in docker-compose.yml, run 'docker compose up -d'," >&2
      echo "or use the default device flow: $0" >&2
      exit 1
    fi
    docker exec -it "$CONTAINER" codex login
    ;;
  *)
    echo "Starting Codex device authorization inside '$CONTAINER'."
    echo "Open the printed URL on the host and enter the code shown."
    docker exec -it "$CONTAINER" codex login --device-auth
    ;;
esac

echo
docker exec "$CONTAINER" codex login status || true
echo "Verify with: curl -s localhost:${LO_PORT:-8484}/health"
