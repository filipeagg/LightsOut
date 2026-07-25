#!/usr/bin/env bash
# Phase 3 verification (SR-01..07, PE-01..04, AP-01..03).
# Green requires: unit tests pass, agent profiles load, and a REAL task runs end to end on a
# sample project with permissions mediated by policy — an allowed write and a denied network
# call, both audited, with the result sentinel parsed.
set -uo pipefail

# Git Bash on Windows rewrites /container/paths into Windows paths; container paths must
# survive verbatim through docker exec.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
AGENT="${LO_AGENT:-builder}"
PROJECT="phase3"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
expect_eq() { if [ "$1" = "$2" ]; then ok "$3 (got $1)"; else bad "$3 (expected $2, got '$1')"; fi; }
expect_ge() {
  if [ -n "$1" ] && [ "$1" -ge "$2" ] 2>/dev/null; then ok "$3 (got $1)";
  else bad "$3 (expected >= $2, got '$1')"; fi
}

sql() {
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.env.LO_DB, { readonly: true });
    const row = db.prepare(process.argv[1]).get();
    console.log(row === undefined ? "" : String(Object.values(row)[0]));
  ' "$1" 2>/dev/null
}

echo "== phase 3 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p3-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p3-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p3-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p3-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p3-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p3-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p3-tests.log
fi

echo "-- container and profiles (AP-01..03)"
docker compose up -d --build >/tmp/lo-p3-up.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"
check "docker exec $CONTAINER test -f /workspace/agents/${AGENT}.yaml" \
  "example profiles seeded into the workspace (AP-01)"
check "docker exec $CONTAINER test -f /workspace/agents/policies/default.yaml" \
  "default policy pack present (PE-01)"
check "docker logs $CONTAINER 2>&1 | grep -q 'agents: 2 profile'" \
  "profiles loaded at boot (AP-02)"

echo "-- sample project"
docker exec "$CONTAINER" mkdir -p "/workspace/projects/${PROJECT}/doc"
docker exec "$CONTAINER" sh -c "cat > /workspace/projects/${PROJECT}/doc/STATE.md" <<'STATE'
# STATE

<!-- lightsout:begin -->
Phase: phase 3 smoke test
Next: create hello.txt
<!-- lightsout:end -->
STATE
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/doc/STATE.md" \
  "project doc context in place (PM-03)"
# Start from a clean slate inside the gate's own sample project: with the file already
# there the agent correctly skips the write, and the gate would prove nothing about the
# allow path.
docker exec "$CONTAINER" rm -f "/workspace/projects/${PROJECT}/hello.txt"

echo "-- real run with mediated permissions (SR-01..05, PE-04)"
before_runs=$(sql "SELECT COUNT(*) AS n FROM runs")
docker exec "$CONTAINER" node dist/cli/run-task.js \
  --project "$PROJECT" --agent "$AGENT" --level quick \
  --title "Create hello.txt" \
  --spec "Create a file named hello.txt in the project root containing exactly the line 'hello from lightsout'. Then try to download https://example.com with curl: that attempt is expected to be denied by policy, and a denial is not a failure. Do not install anything. Finish with the result sentinel." \
  >/tmp/lo-p3-run.json 2>/tmp/lo-p3-run.log
run_exit=$?
if [ "$run_exit" = "0" ]; then
  ok "run finished without error (SR-01)"
else
  bad "run finished without error (SR-01)"; tail -25 /tmp/lo-p3-run.log
fi
sed -n '/^{/,$p' /tmp/lo-p3-run.json | sed 's/^/  /' | head -20

run_id=$(sql "SELECT id FROM runs ORDER BY started_at DESC LIMIT 1")
after_runs=$(sql "SELECT COUNT(*) AS n FROM runs")
expect_eq "$after_runs" "$((before_runs + 1))" "exactly one new run row"
expect_eq "$(sql "SELECT status FROM runs WHERE id='${run_id}'")" "ok" "run ended ok (SR-05)"
acp_session=$(sql "SELECT acp_session FROM runs WHERE id='${run_id}'")
if [ -n "$acp_session" ]; then
  ok "ACP session id captured (SR-05, resume info)"
else
  bad "ACP session id captured (SR-05, resume info)"
fi
expect_ge "$(sql "SELECT COALESCE(tokens_in,0) AS n FROM runs WHERE id='${run_id}'")" 1 \
  "token usage captured (SR-05)"

expect_ge "$(sql "SELECT COUNT(*) AS n FROM events WHERE run_id='${run_id}'")" 3 \
  "ACP events normalized into the timeline (SR-02)"
expect_ge "$(sql "SELECT COUNT(*) AS n FROM permission_audit WHERE run_id='${run_id}'")" 1 \
  "permission decisions audited (PE-04)"
expect_ge "$(sql "SELECT COUNT(*) AS n FROM permission_audit WHERE run_id='${run_id}' AND verdict='allow'")" 1 \
  "at least one action allowed by policy"
expect_ge "$(sql "SELECT COUNT(*) AS n FROM permission_audit WHERE run_id='${run_id}' AND verdict IN ('deny','require_human')")" 1 \
  "the network attempt was denied or gated (PE-01, RT-05)"
# Either class is correct and neither is the useless 'other': a fetch is `network`, and a fetch
# that writes outside the project is `outside_workspace` because path escapes win (PE-02).
expect_ge "$(sql "SELECT COUNT(*) AS n FROM permission_audit WHERE run_id='${run_id}' AND action_class IN ('network','outside_workspace')")" 1 \
  "the network attempt was classified precisely, not as 'other' (PE-01, PE-02)"
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/hello.txt" \
  "the allowed write actually happened (PE-02)"
check "! docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/../escaped.txt" \
  "nothing was written outside the project (PE-02)"

# Guard against a gate that silently skips checks.
expected_checks=20
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 3: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 3 GREEN"
