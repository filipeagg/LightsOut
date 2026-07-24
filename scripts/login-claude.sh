#!/usr/bin/env bash
# One-time interactive login for the Claude engine (RT-04).
#
# Same approach as login-codex.sh: an ephemeral container on the host network with
# the claude-auth volume mounted (RT-03), so an OAuth loopback callback can reach
# the login server. Works with subscription plans and Console billing (NF-03).
#
# Usage:
#   ./scripts/login-claude.sh              # Claude subscription (default)
#   ./scripts/login-claude.sh --console    # Anthropic Console / API billing
#   ./scripts/login-claude.sh --token      # long-lived token (claude setup-token)
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-lightsout}"
VOLUME="${LO_CLAUDE_VOLUME:-${PROJECT}_claude-auth}"
IMAGE="${LO_IMAGE:-lightsout:local}"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "Volume '$VOLUME' not found. Start the stack once: docker compose up -d" >&2
  exit 1
fi

run_login() {
  docker run --rm -it \
    --network host \
    --user 1000:1000 \
    -e CLAUDE_CONFIG_DIR=/home/app/.claude \
    -v "$VOLUME":/home/app/.claude \
    "$IMAGE" "$@"
}

case "${1:-}" in
  --token) run_login claude setup-token ;;
  --console) run_login claude auth login --console ;;
  *) run_login claude auth login --claudeai ;;
esac

echo
docker exec "${LO_CONTAINER:-lightsout}" claude auth status || true
echo "Verify with: curl -s localhost:${LO_PORT:-8484}/health"
