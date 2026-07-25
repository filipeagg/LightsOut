#!/usr/bin/env bash
# Phase 6 verification (MC-01..06).
#
# Green requires: the MCP endpoint lists every tool of DESIGN §10.2; a full flow is driven
# through MCP only (create project, launch a chain, poll status, read docs, history); the write
# guard and the error envelope behave; and the stdio bridge answers a real JSON-RPC frame the
# way Claude Desktop will send it.
set -uo pipefail

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
AGENT="${LO_AGENT:-builder}"
PROJECT="p6mcp"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
expect_ge() {
  if [ -n "$1" ] && [ "$1" -ge "$2" ] 2>/dev/null; then ok "$3 (got $1)";
  else bad "$3 (expected >= $2, got '$1')"; fi
}

mcp() { # mcp [tool] [json args] — no tool lists the tool set
  if [ "$#" -eq 0 ]; then
    docker exec -w /opt/lightsout "$CONTAINER" node mcp-call.mjs 2>/dev/null
    return
  fi
  mcp_args="${2:-}"
  [ -z "$mcp_args" ] && mcp_args='{}'
  docker exec -w /opt/lightsout "$CONTAINER" node mcp-call.mjs "$1" "$mcp_args" 2>/dev/null
}
jq_get() { # jq_get <json> <node expression over the parsed object>
  printf '%s' "$1" | docker exec -i "$CONTAINER" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const fn = new Function("j", `return ${process.argv[1]};`);
        const v = fn(j);
        console.log(v === undefined || v === null ? "" : String(v));
      } catch {
        console.log("");
      }
    });
  ' "$2" 2>/dev/null
}

echo "== phase 6 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p6-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p6-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p6-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p6-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p6-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p6-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p6-tests.log
fi

docker compose up -d --build >/tmp/lo-p6-up.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
docker cp scripts/mcp-call.mjs "$CONTAINER":/opt/lightsout/mcp-call.mjs >/dev/null 2>&1
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

echo "-- the endpoint and its tool set (MC-01, MC-02)"
tools=$(mcp)
for name in health list_projects create_project project_status list_agents reload_agents \
            launch_chain launch_task abort_run list_doubts answer_doubt get_history \
            read_doc write_doc consult; do
  if printf '%s' "$tools" | grep -q "\"$name\""; then
    ok "tool $name is exposed (MC-02)"
  else
    bad "tool $name is exposed (MC-02)"
  fi
done

health=$(mcp health)
check "printf '%s' \"\$health\" | grep -q '\"ok\": true'" "health answers through MCP (RT-06)"
check "printf '%s' \"\$health\" | grep -q '\"auth\": true'" "health reports engine auth through MCP"

echo "-- a full flow driven through MCP only (MC-06)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}"
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB);
  db.prepare("DELETE FROM doubts WHERE project_id = ?").run(process.argv[1]);
  db.prepare("DELETE FROM decisions WHERE project_id = ?").run(process.argv[1]);
' "$PROJECT" >/dev/null 2>&1

created=$(mcp create_project "{\"name\":\"${PROJECT}\",\"verify\":\"test -f mcp.txt\"}")
project_id=$(jq_get "$created" "j.project.id")
if [ "$project_id" = "$PROJECT" ]; then
  ok "create_project scaffolded the project (PM-01) (got $project_id)"
else
  bad "create_project scaffolded the project (PM-01) (got '$project_id')"
fi
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/lightsout.yaml" \
  "the scaffold wrote lightsout.yaml"
check "docker exec -w /workspace/projects/${PROJECT} $CONTAINER git log --oneline" \
  "the scaffold created a git repository with a commit (PM-04)"

agents_json=$(mcp list_agents)
check "printf '%s' \"\$agents_json\" | grep -q '\"${AGENT}\"'" "list_agents lists the profiles (AP-02)"

start=$(date +%s)
launched=$(mcp launch_chain "{\"projectId\":\"${PROJECT}\",\"title\":\"MCP flow\",\"tasks\":[{\"title\":\"Create mcp.txt\",\"spec\":\"Create a file mcp.txt in the project root containing the single line 'driven by mcp'. Nothing else.\",\"agentId\":\"${AGENT}\",\"level\":\"quick\"}]}")
elapsed=$(( $(date +%s) - start ))
chain_id=$(jq_get "$launched" "j.chainId")
if [ -n "$chain_id" ]; then
  ok "launch_chain returned a chain id"
else
  bad "launch_chain returned a chain id"; echo "  $launched"
fi
if [ "$elapsed" -le 5 ]; then
  ok "launch_chain returned immediately (MC-06) (${elapsed}s)"
else
  bad "launch_chain returned immediately (MC-06) (${elapsed}s)"
fi

status=$(mcp project_status "{\"projectId\":\"${PROJECT}\"}")
check "printf '%s' \"\$status\" | grep -q '\"chain\"'" "project_status returns the whole picture (MC-06)"

echo "-- waiting for the chain to finish"
for _ in $(seq 1 60); do
  sleep 5
  status=$(mcp project_status "{\"projectId\":\"${PROJECT}\"}")
  chain_status=$(jq_get "$status" "j.chain.status")
  [ "$chain_status" = "completed" ] && break
  [ "$chain_status" = "paused" ] && break
  open_ref=$(jq_get "$status" "j.doubts.length ? j.doubts[0].ref : ''")
  if [ -n "$open_ref" ]; then
    echo "  INFO  answering ${open_ref} through MCP"
    mcp answer_doubt "{\"projectId\":\"${PROJECT}\",\"doubtId\":\"${open_ref}\",\"choice\":\"A\",\"note\":\"phase 6 gate\"}" >/dev/null
  fi
done
echo "  INFO  chain status: ${chain_status:-unknown}"

if [ "${chain_status}" = "completed" ]; then
  ok "the chain completed while driven through MCP (OR-02)"
else
  bad "the chain completed while driven through MCP (OR-02) (status ${chain_status:-unknown})"
fi
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/mcp.txt" \
  "the task artifact exists"

history=$(mcp get_history "{\"projectId\":\"${PROJECT}\"}")
check "printf '%s' \"\$history\" | grep -q '\"runs\"'" "get_history returns past runs (OB-05)"
doc=$(mcp read_doc "{\"projectId\":\"${PROJECT}\",\"doc\":\"STATE\"}")
check "printf '%s' \"\$doc\" | grep -q 'lightsout:begin'" "read_doc returns the managed STATE.md (PM-02)"

echo "-- guards and the error envelope (MC-04, §10.2)"
written=$(mcp write_doc "{\"projectId\":\"${PROJECT}\",\"doc\":\"PLAN\",\"content\":\"# PLAN\\n\\nwritten through mcp\\n\"}")
check "printf '%s' \"\$written\" | grep -q '\"written\": true'" "write_doc writes inside doc/ (MC-04)"
missing_project=$(mcp project_status '{"projectId":"does-not-exist"}')
check "printf '%s' \"\$missing_project\" | grep -q 'NOT_FOUND'" \
  "an unknown project answers NOT_FOUND, not a crash (§10.2)"
bad_agent=$(mcp launch_task "{\"projectId\":\"${PROJECT}\",\"title\":\"x\",\"spec\":\"y\",\"agentId\":\"ghost\"}")
check "printf '%s' \"\$bad_agent\" | grep -q '\"ok\": false'" \
  "an unknown agent profile is refused with an envelope"

echo "-- the stdio bridge Claude Desktop will use (MC-01)"
frame='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"desktop","version":"0"}}}'
printf '%s\n' "$frame" > /tmp/lo-p6-frame.json
bridge=$(docker exec -i "$CONTAINER" node dist/mcp/stdio-bridge.js < /tmp/lo-p6-frame.json 2>/dev/null | head -1)
if printf '%s' "$bridge" | grep -q '"serverInfo"'; then
  ok "the stdio bridge answers initialize (MC-01)"
else
  bad "the stdio bridge answers initialize (MC-01)"; echo "  ${bridge:-<no output>}"
fi

# Guard against a gate that silently skips checks.
expected_checks=36
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 6: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 6 GREEN"
