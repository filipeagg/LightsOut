#!/usr/bin/env bash
# Phase 2 verification (DB-01..03).
# Green requires: typecheck clean, unit tests pass, migrations applied inside the
# running container, schema present in the real database, WAL enabled, and /health
# reporting the database from a live query.
set -uo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }

echo "== phase 2 verification =="

echo "-- typecheck and unit tests (in the test image)"
if docker build --target test -t lightsout:test . >/tmp/lo-test-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds (see /tmp/lo-test-build.log)"; tail -20 /tmp/lo-test-build.log
fi

if docker run --rm lightsout:test npm run typecheck >/tmp/lo-typecheck.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-typecheck.log
fi

if docker run --rm lightsout:test npm test >/tmp/lo-tests.log 2>&1; then
  ok "unit tests pass"
  grep -E "Tests +[0-9]+ passed" /tmp/lo-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-tests.log
fi

echo "-- migrations in the running container"
docker compose up -d --build >/tmp/lo-up.log 2>&1
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done

# Query the real database inside the container. The SQL is passed as argv, never
# interpolated into the script, so quoting cannot silently skip a check.
sql() {
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.env.LO_DB, { readonly: true });
    const row = db.prepare(process.argv[1]).get();
    console.log(String(Object.values(row)[0]));
  ' "$1" 2>/dev/null
}

expect_eq() { # expect_eq <actual> <expected> <label>
  if [ "$1" = "$2" ]; then ok "$3 (got $1)"; else bad "$3 (expected $2, got '$1')"; fi
}
expect_ge() { # expect_ge <actual> <minimum> <label>
  if [ -n "$1" ] && [ "$1" -ge "$2" ] 2>/dev/null; then ok "$3 (got $1)";
  else bad "$3 (expected >= $2, got '$1')"; fi
}

schema_version=$(sql 'SELECT MAX(version) AS v FROM schema_migrations')
table_count=$(sql "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
view_count=$(sql "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view'")

expect_eq "$schema_version" "1" "migration 1 applied in /data/lightsout.db (DB-01)"
expect_ge "$table_count" 10 "all tables created (DB-01)"
expect_ge "$view_count" 2 "aggregation views created (OB-05)"
check "docker exec $CONTAINER test -f /data/lightsout.db-wal" "WAL journal in use (DB-01)"

health=$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null)
if printf '%s' "$health" | grep -q '"database":{"path":"/data/lightsout.db","ok":true}'; then
  ok "/health reports the database from a live query (RT-06)"
else
  bad "/health reports the database from a live query (RT-06)"; echo "  $health"
fi

echo "-- restart safety (RT-07)"
docker compose restart >/tmp/lo-restart.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
expect_eq "$(sql 'SELECT MAX(version) AS v FROM schema_migrations')" "1" \
  "migrations are idempotent across restarts"

health_after=$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null)
if printf '%s' "$health_after" | grep -q '"status":"ok"'; then
  ok "health green after restart"
else
  bad "health green after restart"; echo "  $health_after"
fi

# Guard against a gate that silently skips checks: phase 2 has a known check count.
expected_checks=11
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 2: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 2 GREEN"
