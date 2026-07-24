#!/usr/bin/env bash
# Phase 1 verification (RT-01..06, NF-01/03).
# Green requires: image builds, container up, /health answers, both ACP adapters
# detected, both engines authenticated, credential volumes present.
# Usage: ./scripts/verify/phase1.sh [--no-build]
set -uo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }

echo "== phase 1 verification =="

check "command -v docker" "docker CLI available"
check "docker info" "docker daemon reachable"
check "docker compose version" "docker compose v2 available"
check "test -f .env" ".env present (copy from .env.example)"

if [ "$BUILD" = "1" ]; then
  echo "-- building image (RT-01)"
  if docker compose build >/tmp/lo-build.log 2>&1; then ok "image builds"; else
    bad "image builds (see /tmp/lo-build.log)"; tail -20 /tmp/lo-build.log
  fi
  docker compose up -d >/dev/null 2>&1
fi

check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running (RT-01)"

echo "-- waiting for /health"
health=""
for _ in $(seq 1 30); do
  health=$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null) && break
  sleep 1
done
if [ -n "$health" ]; then ok "/health answers (RT-06)"; else bad "/health answers (RT-06)"; fi

if [ -n "$health" ]; then
  # Flatten the health payload into KEY=value lines using the container's node.
  summary=$(docker exec "$CONTAINER" node -e '
    const r = await fetch("http://127.0.0.1:8484/health");
    const j = await r.json();
    const e = j.engines ?? [];
    console.log("STATUS=" + j.status);
    console.log("DB_OK=" + (j.database?.ok === true));
    console.log("ENGINES=" + e.length);
    console.log("DETECTED=" + e.filter((x) => x.detected).length);
    console.log("AUTHED=" + e.filter((x) => x.auth).length);
    console.log("NETWORK=" + j.network);
  ' 2>/dev/null)

  get() { printf '%s\n' "$summary" | sed -n "s/^$1=//p"; }

  check "[ \"$(get DB_OK)\" = true ]" "health reports database (RT-06)"
  check "[ \"$(get ENGINES)\" = 2 ]" "health reports both engines (RT-06)"
  check "[ \"$(get DETECTED)\" = 2 ]" "both ACP adapters detected"
  check "[ \"$(get AUTHED)\" = 2 ]" "both engines authenticated (RT-04, NF-03)"
  echo "  INFO  network: $(get NETWORK)  (RT-05: 'proxy' when the secure overlay is active)"
fi

echo "-- credential and data volumes (RT-03, DB-01)"
for v in claude-auth codex-auth lightsout-db; do
  check "docker volume ls --format '{{.Name}}' | grep -q ${v}\$" "volume ${v} exists"
done
check "docker exec $CONTAINER test -d /workspace" "workspace bind mount present (RT-02)"
check "docker exec $CONTAINER sh -lc 'command -v claude-agent-acp'" "claude-agent-acp on PATH"
check "docker exec $CONTAINER sh -lc 'command -v codex-acp'" "codex-acp on PATH"

echo "-- engine CLIs"
check "docker exec $CONTAINER sh -lc 'command -v claude'" "claude CLI on PATH"
check "docker exec $CONTAINER sh -lc 'command -v codex'" "codex CLI on PATH"

# Guard against a gate that silently skips checks (a quoting slip must not read green).
expected_checks=19
[ "$BUILD" = "1" ] || expected_checks=18
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 1: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 1 GREEN"
