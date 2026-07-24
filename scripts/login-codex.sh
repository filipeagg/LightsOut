#!/usr/bin/env bash
# One-time interactive login for the Codex engine (RT-04).
#
# The login runs in an ephemeral container that shares the host network namespace
# and mounts the codex-auth volume (RT-03). Host networking matters: the OAuth
# callback goes to localhost:1455, and a login server bound to the loopback of an
# isolated container namespace is unreachable from the host even with a published
# port. The long-lived orchestrator container keeps its own isolated network.
#
# Usage:
#   ./scripts/login-codex.sh                                   # ChatGPT subscription
#   OPENAI_API_KEY=sk-... ./scripts/login-codex.sh --api-key    # API billing (NF-03)
#   ./scripts/login-codex.sh --device-auth                      # if your workspace allows it
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-lightsout}"
VOLUME="${LO_CODEX_VOLUME:-${PROJECT}_codex-auth}"
IMAGE="${LO_IMAGE:-lightsout:local}"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "Volume '$VOLUME' not found. Start the stack once: docker compose up -d" >&2
  exit 1
fi

run_login() {
  docker run --rm -it \
    --network host \
    --user 1000:1000 \
    -e CODEX_HOME=/home/app/.codex \
    -v "$VOLUME":/home/app/.codex \
    "$IMAGE" "$@"
}

case "${1:-}" in
  --api-key)
    : "${OPENAI_API_KEY:?set OPENAI_API_KEY in the environment first}"
    printf '%s' "$OPENAI_API_KEY" | docker run --rm -i \
      --user 1000:1000 \
      -e CODEX_HOME=/home/app/.codex \
      -v "$VOLUME":/home/app/.codex \
      "$IMAGE" codex login --with-api-key
    ;;
  --device-auth)
    run_login codex login --device-auth
    ;;
  *)
    echo "Opening the Codex browser login. Complete it in the browser that opens,"
    echo "or copy the printed URL into one on this machine."
    run_login codex login
    ;;
esac

echo
docker exec "${LO_CONTAINER:-lightsout}" codex login status || true
echo "Verify with: curl -s localhost:${LO_PORT:-8484}/health"
