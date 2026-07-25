#!/usr/bin/env bash
# Phase 5 verification (DO-01..05, SR-08, PE-06).
#
# Green requires, with real engines: the advisor (the other engine) is consulted before a doubt
# opens; agreement produces a provisional decision with a git checkpoint tag and work continues;
# a doubt that opens carries the second opinion and is mirrored into QUESTIONS.md; answering it
# from a separate process releases the run and records a human decision.
#
# The gate plays the human: while the chain runs it answers any doubt that appears, so the run
# is never left waiting on the 24 h slow clock.
set -uo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
AGENT="${LO_AGENT:-builder}"
PROJECT="p5doubt"
BUDGET_S="${LO_PHASE5_BUDGET_S:-420}"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
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

echo "== phase 5 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p5-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p5-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p5-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p5-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p5-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p5-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p5-tests.log
fi

docker compose up -d --build >/tmp/lo-p5-up.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

echo "-- an ambiguous task, with the gate playing the human (DO-02..05, SR-08)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}"
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB);
  db.prepare("DELETE FROM doubts WHERE project_id = ?").run(process.argv[1]);
  db.prepare("DELETE FROM decisions WHERE project_id = ?").run(process.argv[1]);
' "$PROJECT" >/dev/null 2>&1

docker exec "$CONTAINER" node dist/cli/run-chain.js \
  --project "$PROJECT" --agent "$AGENT" --level quick \
  --chain "Ambiguous storage" \
  --task "Store the user settings :: Add a module that persists user settings for this project. The repository gives no indication of how storage is done and there is no precedent: a JSON file on disk and an in-memory store are both defensible, and the choice changes the result. This is a decision a human must own: raise a doubt with both options and a recommendation instead of choosing on your own." \
  >/tmp/lo-p5-run.json 2>/tmp/lo-p5-run.log &
chain_pid=$!

answered=0
deadline=$(( $(date +%s) + BUDGET_S ))
while kill -0 "$chain_pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 5
  open_ref=$(sql "SELECT ref FROM doubts WHERE project_id='${PROJECT}' AND status='open' ORDER BY created_at LIMIT 1")
  [ -z "$open_ref" ] && continue
  echo "  INFO  answering ${open_ref} as the human would"
  docker exec "$CONTAINER" node dist/cli/doubts.js answer \
    --project "$PROJECT" --doubt "$open_ref" --choice A --note "answered by the phase 5 gate" \
    >>/tmp/lo-p5-answer.json 2>&1 && answered=$((answered + 1))
done
if kill -0 "$chain_pid" 2>/dev/null; then
  echo "  INFO  budget of ${BUDGET_S}s spent, stopping the run"
  kill "$chain_pid" 2>/dev/null
  docker exec "$CONTAINER" pkill -f run-chain.js >/dev/null 2>&1
fi
wait "$chain_pid" 2>/dev/null
sed -n '/^{/,$p' /tmp/lo-p5-run.json | head -20 | sed 's/^/  /'

# Facts, read once from the database.
advisor_events=$(sql "SELECT COUNT(*) AS n FROM events WHERE type='advisor.consulted'")
advisor_engine=$(sql "SELECT json_extract(payload,'\$.engine') AS e FROM events WHERE type='advisor.consulted' ORDER BY id DESC LIMIT 1")
doubts_opened=$(sql "SELECT COUNT(*) AS n FROM doubts WHERE project_id='${PROJECT}'")
with_opinion=$(sql "SELECT COUNT(*) AS n FROM doubts WHERE project_id='${PROJECT}' AND second_opinion IS NOT NULL")
provisional=$(sql "SELECT COUNT(*) AS n FROM decisions WHERE project_id='${PROJECT}' AND kind='provisional'")
human=$(sql "SELECT COUNT(*) AS n FROM decisions WHERE project_id='${PROJECT}' AND kind='human'")
answered_doubts=$(sql "SELECT COUNT(*) AS n FROM doubts WHERE project_id='${PROJECT}' AND status='answered'")
options_ok=$(sql "SELECT COUNT(*) AS n FROM doubts WHERE project_id='${PROJECT}' AND json_array_length(options) >= 2")

echo "  INFO  advisor=${advisor_events} doubts=${doubts_opened} provisional=${provisional} human=${human} answered=${answered_doubts}"

expect_ge "$advisor_events" 1 "the advisor was consulted before any doubt (SR-08, DO-02)"
if [ "$advisor_engine" = "codex" ]; then
  ok "the advisor was the other engine (SR-08) (got $advisor_engine)"
else
  bad "the advisor was the other engine (SR-08) (got '$advisor_engine')"
fi

# Either outcome is correct: agreement continues provisionally, disagreement asks the human.
if [ "${provisional:-0}" -ge 1 ] || [ "${doubts_opened:-0}" -ge 1 ]; then
  ok "the doubt was settled by the advisor or opened for the human (DO-02, DO-03)"
else
  bad "the doubt was settled by the advisor or opened for the human (DO-02, DO-03)"
fi

if [ "${provisional:-0}" -ge 1 ]; then
  check "docker exec -w /workspace/projects/${PROJECT} $CONTAINER git tag | grep -q 'lightsout/cp/'" \
    "a checkpoint tag marks the pre-decision commit (PE-06)"
  check "docker exec $CONTAINER grep -q 'provisional' /workspace/projects/${PROJECT}/doc/DECISIONS.md" \
    "the provisional decision reached DECISIONS.md (PM-02)"
else
  ok "no provisional decision to check (advisor did not settle it)"
  ok "no provisional decision to mirror"
fi

if [ "${doubts_opened:-0}" -ge 1 ]; then
  expect_ge "$options_ok" 1 "every doubt carries at least two options (DO-01, MC-03)"
  expect_ge "$with_opinion" 1 "the second opinion is attached to the doubt (DO-03)"
  check "docker exec $CONTAINER grep -q '@DOUBT-' /workspace/projects/${PROJECT}/doc/QUESTIONS.md" \
    "the doubt is mirrored into QUESTIONS.md (DO-01)"
else
  ok "no doubt row to inspect (advisor settled everything)"
  ok "no second opinion to attach"
  ok "no mirror to check"
fi

if [ "$answered" -ge 1 ]; then
  expect_ge "$answered_doubts" 1 "the answer was recorded on the doubt (DO-04)"
  expect_ge "$human" 1 "a human decision was recorded (DO-04)"
  check "docker exec $CONTAINER grep -q 'D-' /workspace/projects/${PROJECT}/doc/DECISIONS.md" \
    "the human decision reached DECISIONS.md (PM-02)"
  check "docker exec $CONTAINER grep -q '@DOUBT-CLOSED' /workspace/projects/${PROJECT}/doc/QUESTIONS.md" \
    "the mirror was regenerated as closed (DO-01)"
else
  ok "nothing to answer (no doubt reached the human)"
  ok "no human decision expected"
  ok "no decision mirror expected"
  ok "no closed mirror expected"
fi

# Guard against a gate that silently skips checks: the branches above are balanced so the
# total is fixed whichever path the run took.
expected_checks=16
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 5: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 5 GREEN"
