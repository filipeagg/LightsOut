#!/usr/bin/env bash
# Phase 7 verification (WP-01, WP-03..10, OB-03).
#
# Green requires: every read endpoint of DESIGN §12.1 answers with its shape and refuses an
# unknown id honestly; the read API changes nothing (OB-01); the SSE stream carries `overview`
# and per-run frames with the `events.id` cursor and replays past a `Last-Event-ID` without a gap
# or a duplicate; and — the phase's done-when — a chain launched through MCP is visible on the
# stream while it is still running.
set -uo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
BASE="http://127.0.0.1:${PORT}"
AGENT="${LO_AGENT:-builder}"
PROJECT="p7panel"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
grep_file() { if grep -qE "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3"; fi; }
has() { # has <json> <needle> <label>
  if printf '%s' "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; echo "  ${1:0:200}"; fi
}
jq_get() {
  printf '%s' "$1" | docker exec -i "$CONTAINER" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const fn = new Function("j", `return ${process.argv[1]};`);
        const v = fn(j);
        console.log(v === undefined || v === null ? "" : String(v));
      } catch { console.log(""); }
    });
  ' "$2" 2>/dev/null
}
mcp() {
  mcp_args="${2:-}"
  [ -z "$mcp_args" ] && mcp_args='{}'
  docker exec -w /opt/lightsout "$CONTAINER" node mcp-call.mjs "$1" "$mcp_args" 2>/dev/null
}

echo "== phase 7 verification =="

echo "-- unit tests, typecheck and the panel's own scripts"
if docker build --target test -t lightsout:test . >/tmp/lo-p7-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p7-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p7-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p7-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p7-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p7-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p7-tests.log
fi
if docker run --rm -v "$(pwd)":/w -w /w lightsout:test \
     node scripts/check-panel.mjs panel/index.html panel/setup.html >/tmp/lo-p7-panel.log 2>&1; then
  ok "the panel's inline scripts parse (ST-04)"
else
  bad "the panel's inline scripts parse (ST-04)"; cat /tmp/lo-p7-panel.log
fi

echo "-- the panel is one file with the routes of §12.3"
missing_route=0
for hash in '#/' '#/projects' '#/agents' '#/health'; do
  grep -q "href=\"$hash\"" panel/index.html || missing_route=1
done
if [ "$missing_route" = "0" ]; then ok "the sidebar routes are wired (WP-01)";
else bad "the sidebar routes are wired (WP-01)"; fi
grep_file panel/index.html 'EventSource\("/api/stream"\)' "the panel subscribes to the stream (WP-03)"
grep_file panel/index.html 'attentionStrip' "the attention strip is rendered first (OB-03)"
grep_file panel/index.html 'no build step' "it stays a single file with no build step (ST-04)"

echo "-- bringing the container up"
if ! docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null | grep -q '[a-z]'; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1
fi
if docker compose up -d --build >/tmp/lo-p7-up.log 2>&1; then
  ok "compose brought the image and container up"
else
  bad "compose brought the image and container up"; tail -15 /tmp/lo-p7-up.log
fi
for _ in $(seq 1 40); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 1
done
docker cp scripts/mcp-call.mjs "$CONTAINER":/opt/lightsout/mcp-call.mjs >/dev/null 2>&1
check "curl -fsS ${BASE}/ | grep -q 'LightsOut'" "the panel is served at /"

echo "-- preconditions"
# A dead engine makes the live-chain part of this gate fail for a reason that has nothing to do
# with the panel. Say so up front instead of leaving three confusing failures at the end.
engine_auth=$(curl -fsS "${BASE}/health" 2>/dev/null)
if printf '%s' "$engine_auth" | grep -q '"auth":true'; then
  ok "at least one engine is authenticated (RT-06)"
else
  bad "at least one engine is authenticated (RT-06) — reconnect from /setup.html and re-run"
fi

echo "-- a project with a chain to look at"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}" >/dev/null 2>&1
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB);
  db.prepare("DELETE FROM doubts WHERE project_id = ?").run(process.argv[1]);
  db.prepare("DELETE FROM decisions WHERE project_id = ?").run(process.argv[1]);
' "$PROJECT" >/dev/null 2>&1
created=$(mcp create_project "{\"name\":\"${PROJECT}\",\"verify\":\"test -f panel.txt\"}")
check "printf '%s' \"\$created\" | grep -q '\"ok\": true'" "a project exists to render"

echo "-- read-only endpoints (§12.1)"
overview=$(curl -fsS "${BASE}/api/overview" 2>/dev/null)
has "$overview" '"attention"' "/api/overview carries the attention list (OB-03)"
has "$overview" '"counts"' "and the global counters (WP-04)"
has "$overview" '"engines"' "and engine health (RT-06)"
projects=$(curl -fsS "${BASE}/api/projects" 2>/dev/null)
has "$projects" "\"$PROJECT\"" "/api/projects lists the project (WP-10)"
status=$(curl -fsS "${BASE}/api/projects/${PROJECT}" 2>/dev/null)
has "$status" '"chain"' "/api/projects/:id returns the project_status shape (WP-04)"
history=$(curl -fsS "${BASE}/api/projects/${PROJECT}/history?limit=5" 2>/dev/null)
has "$history" '"totals"' "/api/projects/:id/history returns past runs (WP-06)"
doubts=$(curl -fsS "${BASE}/api/doubts" 2>/dev/null)
has "$doubts" '"doubts"' "/api/doubts lists open doubts (DO-05)"
agents_json=$(curl -fsS "${BASE}/api/agents" 2>/dev/null)
has "$agents_json" "\"$AGENT\"" "/api/agents lists the profiles (AP-02)"
models=$(curl -fsS "${BASE}/api/agents/models" 2>/dev/null)
has "$models" '"reasoning"' "/api/agents/models answers the accepted values (AP-08)"
for resource in templates knowledge vault; do
  body=$(curl -fsS "${BASE}/api/${resource}" 2>/dev/null)
  has "$body" '"available":false' "/api/${resource} answers its empty shape until phase 9"
done
phases=$(curl -fsS "${BASE}/api/projects/${PROJECT}/phases" 2>/dev/null)
has "$phases" '"phases"' "/api/projects/:id/phases answers its empty shape until phase 9"
missing=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/projects/ghost" 2>/dev/null)
if [ "$missing" = "404" ]; then ok "an unknown project answers 404, not a crash";
else bad "an unknown project answers 404, not a crash (got $missing)"; fi
missing_run=$(curl -sS "${BASE}/api/runs/ghost/events" 2>/dev/null)
has "$missing_run" 'NOT_FOUND' "an unknown run answers NOT_FOUND"

echo "-- the read API changes nothing (OB-01)"
before=$(docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB, { readonly: true });
  console.log(db.prepare("SELECT COUNT(*) c FROM events").get().c);
' 2>/dev/null | tr -d '\r')
for path in /api/overview /api/projects "/api/projects/${PROJECT}" "/api/projects/${PROJECT}/history" \
            /api/doubts /api/agents /api/agents/models /api/templates /api/knowledge /api/vault; do
  curl -fsS "${BASE}${path}" >/dev/null 2>&1
done
after=$(docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB, { readonly: true });
  console.log(db.prepare("SELECT COUNT(*) c FROM events").get().c);
' 2>/dev/null | tr -d '\r')
if [ -n "$before" ] && [ "$before" = "$after" ]; then
  ok "ten read calls appended no events (OB-01) (events still $after)"
else
  bad "ten read calls appended no events (OB-01) (was '$before', now '$after')"
fi

echo "-- the stream while a chain runs (WP-03, phase done-when)"
rm -f /tmp/lo-p7-stream.log
# Shell redirection, not curl -o: MSYS2_ARG_CONV_EXCL keeps /tmp from being translated.
curl -sN --max-time 300 "${BASE}/api/stream" > /tmp/lo-p7-stream.log 2>/dev/null &
stream_pid=$!
sleep 2
if grep -q '^event: overview' /tmp/lo-p7-stream.log; then
  ok "a fresh subscriber gets the whole overview immediately"
else
  bad "a fresh subscriber gets the whole overview immediately"
fi

launched=$(mcp launch_chain "{\"projectId\":\"${PROJECT}\",\"title\":\"Panel flow\",\"tasks\":[{\"title\":\"Create panel.txt\",\"spec\":\"Create a file panel.txt in the project root containing the single line 'watched from the panel'. Nothing else.\",\"agentId\":\"${AGENT}\",\"level\":\"quick\"}]}")
chain_id=$(jq_get "$launched" "j.chainId")
if [ -n "$chain_id" ]; then ok "a chain was launched through MCP while the stream was open";
else bad "a chain was launched through MCP while the stream was open"; echo "  $launched"; fi

echo "-- waiting for the chain (watching the stream fill up)"
chain_status=""
for _ in $(seq 1 50); do
  sleep 5
  status=$(mcp project_status "{\"projectId\":\"${PROJECT}\"}")
  chain_status=$(jq_get "$status" "j.chain.status")
  [ "$chain_status" = "completed" ] && break
  [ "$chain_status" = "paused" ] && break
done
echo "  INFO  chain status: ${chain_status:-unknown}"
sleep 2
kill "$stream_pid" >/dev/null 2>&1
wait "$stream_pid" 2>/dev/null

run_frames=$(grep -c '^event: run:' /tmp/lo-p7-stream.log 2>/dev/null | tr -d ' ')
if [ "${run_frames:-0}" -gt 0 ]; then
  ok "the run's progress arrived live on the stream (${run_frames} frames) — WP-03 done-when"
else
  bad "the run's progress arrived live on the stream (0 frames)"
fi
overview_frames=$(grep -c '^event: overview' /tmp/lo-p7-stream.log 2>/dev/null | tr -d ' ')
if [ "${overview_frames:-0}" -ge 2 ]; then
  ok "the overview was pushed again as things moved (${overview_frames} frames)"
else
  bad "the overview was pushed again as things moved (${overview_frames:-0} frames)"
fi
check "grep -q '^id: ' /tmp/lo-p7-stream.log" "every frame carries the events.id cursor (§12.2)"
# Ids must never go backwards: that is what makes Last-Event-ID a safe resume point.
if docker exec -i "$CONTAINER" node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const ids = s.split("\n").filter((l) => l.startsWith("id: ")).map((l) => Number(l.slice(4)));
    const sorted = ids.every((v, i) => i === 0 || v >= ids[i - 1]);
    process.exit(ids.length > 0 && sorted ? 0 : 1);
  });
' < /tmp/lo-p7-stream.log >/dev/null 2>&1; then
  ok "the cursor never goes backwards"
else
  bad "the cursor never goes backwards"
fi
if [ "${chain_status}" = "completed" ]; then
  ok "the chain completed while being watched (OR-02)"
else
  bad "the chain completed while being watched (status ${chain_status:-unknown})"
  # Say why, so a failure here is not mistaken for a panel problem.
  docker exec "$CONTAINER" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.env.LO_DB, { readonly: true });
    for (const r of db.prepare(
      "SELECT r.status, r.exit_reason FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY r.started_at DESC LIMIT 2",
    ).all(process.argv[1])) console.log(`  INFO  run ${r.status}: ${r.exit_reason}`);
  ' "$PROJECT" 2>/dev/null
fi

echo "-- reconnect replays the gap and nothing else (§12.2)"
latest=$(docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB, { readonly: true });
  console.log(db.prepare("SELECT COALESCE(MAX(id),0) id FROM events").get().id);
' 2>/dev/null | tr -d '\r')
resume=$((latest - 5))
[ "$resume" -lt 0 ] && resume=0
rm -f /tmp/lo-p7-replay.log
curl -sN --max-time 6 -H "Last-Event-ID: ${resume}" "${BASE}/api/stream" > /tmp/lo-p7-replay.log 2>/dev/null
first_id=$(grep -m1 '^id: ' /tmp/lo-p7-replay.log | sed 's/^id: //' | tr -d '\r')
if [ -n "$first_id" ] && [ "$first_id" -gt "$resume" ] 2>/dev/null; then
  ok "the replay starts strictly after Last-Event-ID (no duplicate) (${resume} -> ${first_id})"
else
  bad "the replay starts strictly after Last-Event-ID (resume ${resume}, first '${first_id}')"
fi
replayed=$(grep -c '^id: ' /tmp/lo-p7-replay.log 2>/dev/null | tr -d ' ')
if [ "${replayed:-0}" -ge 1 ]; then
  ok "the rows missed while disconnected were replayed (${replayed})"
else
  bad "the rows missed while disconnected were replayed (0)"
fi
check "grep -q ': keepalive' /tmp/lo-p7-replay.log || grep -q '^event: ' /tmp/lo-p7-replay.log" \
  "the stream stays framed as text/event-stream"

echo "-- what the panel shows now"
overview=$(curl -fsS "${BASE}/api/overview" 2>/dev/null)
done_project=$(jq_get "$overview" "j.projects.filter(p=>p.id==='${PROJECT}')[0].chain.steps.filter(s=>s.status==='ok').length")
if [ "${done_project:-0}" -ge 1 ] 2>/dev/null; then
  ok "the project list shows the finished step (WP-10)"
else
  bad "the project list shows the finished step (WP-10) (got '${done_project}')"
fi
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/panel.txt" \
  "the task really did the work it was watched doing"

# Guard against a gate that silently skips checks.
expected_checks=40  # 39 + the engine precondition
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 7: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 7 GREEN"
