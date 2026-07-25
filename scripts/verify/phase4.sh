#!/usr/bin/env bash
# Phase 4 verification (OR-01..08, PM-01..05).
# Green requires: unit tests pass; a 3-task chain completes unattended with one git commit per
# task and a green verify gate; the managed doc blocks are written; and a chain whose verify
# fails pauses instead of continuing.
set -uo pipefail

# Git Bash on Windows rewrites /container/paths into Windows paths; container paths must
# survive verbatim through docker exec.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
AGENT="${LO_AGENT:-builder}"
GOOD="p4good"
BAD="p4bad"

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

echo "== phase 4 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p4-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p4-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p4-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p4-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p4-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p4-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p4-tests.log
fi

docker compose up -d --build >/tmp/lo-p4-up.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

echo "-- 3-task chain, unattended (OR-01..03, PM-01, PM-04)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${GOOD}"
# Since phase 5 a permission gate holds the run until a human answers, so the gate plays the
# human in the background: otherwise an unattended chain could wait on the 24 h slow clock.
answer_doubts_while_running() {
  local pid="$1" budget_s="$2" ref
  local deadline=$(( $(date +%s) + budget_s ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    ref=$(sql "SELECT ref FROM doubts WHERE status='open' ORDER BY created_at DESC LIMIT 1")
    [ -z "$ref" ] && continue
    project=$(sql "SELECT project_id FROM doubts WHERE ref='${ref}' AND status='open' ORDER BY created_at DESC LIMIT 1")
    echo "  INFO  answering ${project}/${ref} as the human would"
    docker exec "$CONTAINER" node dist/cli/doubts.js answer \
      --project "$project" --doubt "$ref" --choice A --note "answered by the gate" >/dev/null 2>&1
  done
}

docker exec "$CONTAINER" node dist/cli/run-chain.js \
  --project "$GOOD" --agent "$AGENT" --level quick \
  --verify "test -f one.txt" \
  --chain "Three files" \
  --task "Create one.txt :: Create a file one.txt in the project root with the single line 'one'. Nothing else." \
  --task "Create two.txt :: Create a file two.txt in the project root with the single line 'two'. Nothing else." \
  --task "Create three.txt :: Create a file three.txt in the project root with the single line 'three'. Nothing else." \
  >/tmp/lo-p4-chain.json 2>/tmp/lo-p4-chain.log &
chain_bg=$!
answer_doubts_while_running "$chain_bg" "${LO_PHASE4_BUDGET_S:-600}"
wait "$chain_bg"
chain_exit=$?
if [ "$chain_exit" = "0" ]; then
  ok "chain completed unattended (OR-02)"
else
  bad "chain completed unattended (OR-02)"; tail -25 /tmp/lo-p4-chain.log
fi
sed -n '/^{/,$p' /tmp/lo-p4-chain.json | head -30 | sed 's/^/  /'

chain_id=$(sql "SELECT c.id FROM chains c WHERE c.project_id='${GOOD}' ORDER BY c.created_at DESC LIMIT 1")
expect_eq "$(sql "SELECT status FROM chains WHERE id='${chain_id}'")" "completed" \
  "chain status completed (OR-02)"
expect_eq "$(sql "SELECT COUNT(*) AS n FROM tasks WHERE chain_id='${chain_id}' AND status='ok'")" "3" \
  "all three tasks ended ok"
expect_eq "$(sql "SELECT COUNT(*) AS n FROM tasks WHERE chain_id='${chain_id}' AND position IN (1,2,3)")" "3" \
  "tasks kept their chain order (OR-01)"

echo "-- artifacts, git and docs (PM-01..05)"
for file in one.txt two.txt three.txt; do
  check "docker exec $CONTAINER test -f /workspace/projects/${GOOD}/${file}" \
    "task artifact ${file} exists"
done
expect_ge "$(sql "SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.chain_id='${chain_id}' AND r.final_commit IS NOT NULL")" 3 \
  "every task recorded its final commit (PM-04)"
expect_ge "$(sql "SELECT COUNT(*) AS n FROM events e JOIN runs r ON r.id=e.run_id JOIN tasks t ON t.id=r.task_id WHERE t.chain_id='${chain_id}' AND e.type='git.commit'")" 1 \
  "consolidated commits recorded as events (PM-04)"
commits=$(docker exec -w "/workspace/projects/${GOOD}" "$CONTAINER" git log --oneline 2>/dev/null | wc -l)
expect_ge "$commits" 4 "git history has the scaffold commit plus one per task"
check "docker exec -w /workspace/projects/${GOOD} $CONTAINER git log --format=%s -1 | grep -q '\[lo:'" \
  "commit messages carry the task id (PM-04)"
check "docker exec $CONTAINER grep -q 'lightsout:begin' /workspace/projects/${GOOD}/doc/STATE.md" \
  "STATE.md has the managed block (PM-02)"
check "docker exec $CONTAINER grep -q 'chain \"Three files\" 3/3' /workspace/projects/${GOOD}/doc/STATE.md" \
  "STATE.md reports the finished chain from the database (PM-02, OB-01)"
plan_ticked=$(docker exec "$CONTAINER" grep -c -- "- \[x\]" "/workspace/projects/${GOOD}/doc/PLAN.md" 2>/dev/null)
expect_eq "${plan_ticked:-0}" "3" "PLAN.md checkboxes ticked by task id (PM-02)"
expect_ge "$(sql "SELECT COUNT(*) AS n FROM events WHERE type='verify.result'")" 1 \
  "verify gate ran and was recorded (OR-04)"

# Chain pausing on a failed verify gate is covered deterministically by the unit tests
# (test/orchestrator.test.ts): a live agent correctly refuses an impossible acceptance
# command and raises a doubt instead, which is what the next scenario checks.
echo "-- a contradictory task raises a doubt instead of guessing (DO-01, DO-03)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${BAD}"
docker exec "$CONTAINER" node dist/cli/run-chain.js \
  --project "$BAD" --agent "$AGENT" --level quick \
  --verify "test -f never-created.txt" \
  --chain "Contradictory gate" \
  --task "Create only.txt :: Create a file only.txt in the project root with the single line 'only'. Nothing else." \
  --task "Second task :: Create a file second.txt with the line 'second'." \
  >/tmp/lo-p4-bad.json 2>/tmp/lo-p4-bad.log &
bad_bg=$!
# Nothing is answered here on purpose: the point is that the doubt stays for the human. The
# wait is bounded so a held permission cannot park the gate on the slow clock.
bad_deadline=$(( $(date +%s) + ${LO_PHASE4_BUDGET_S:-600} ))
while kill -0 "$bad_bg" 2>/dev/null && [ "$(date +%s)" -lt "$bad_deadline" ]; do sleep 5; done
if kill -0 "$bad_bg" 2>/dev/null; then
  echo "  INFO  budget spent, stopping the run"
  kill "$bad_bg" 2>/dev/null
  docker exec "$CONTAINER" pkill -f run-chain.js >/dev/null 2>&1
fi
wait "$bad_bg" 2>/dev/null
bad_exit=$?
if [ "$bad_exit" != "0" ]; then
  ok "the chain did not report success"
else
  bad "the chain did not report success"
fi
bad_chain=$(sql "SELECT id FROM chains WHERE project_id='${BAD}' ORDER BY created_at DESC LIMIT 1")
# Since phase 5 the outcome can be either: parked in doubt, or requeued after the advisor
# settled it provisionally. What must never happen is the task reporting success.
expect_eq "$(sql "SELECT COUNT(*) AS n FROM tasks WHERE chain_id='${bad_chain}' AND status='ok'")" "0" \
  "the task did not report success (DO-03)"
expect_eq "$(sql "SELECT COUNT(*) AS n FROM tasks WHERE chain_id='${bad_chain}' AND status='queued'")" "1" \
  "the next task was never started"
doubt_ref=$(sql "SELECT ref FROM doubts WHERE project_id='${BAD}' ORDER BY created_at DESC LIMIT 1")
# The ref counter is per project and survives re-runs of this gate, so only the shape matters.
if printf '%s' "$doubt_ref" | grep -Eq '^D-[0-9]+$'; then
  ok "a doubt was recorded with a per-project ref (DO-01) (got $doubt_ref)"
else
  bad "a doubt was recorded with a per-project ref (DO-01) (got '$doubt_ref')"
fi
expect_ge "$(sql "SELECT COUNT(*) AS n FROM doubts WHERE project_id='${BAD}' AND json_array_length(options) >= 2")" 1 \
  "the doubt carries at least two options (MC-03)"
check "! docker exec $CONTAINER test -f /workspace/projects/${BAD}/second.txt" \
  "the second task produced nothing"

# Guard against a gate that silently skips checks.
expected_checks=25
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 4: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 4 GREEN"
