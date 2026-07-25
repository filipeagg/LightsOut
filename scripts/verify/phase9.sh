#!/usr/bin/env bash
# Phase 9 verification (BA-*, TP-*, KB-*, VT-*, PM-06/07).
#
# Green requires: the builtin library ships in the image and loads; the four templates are
# usable; a project created from `full-development` through MCP materialises its phases in
# order with a knowledge base attached; the first phase runs a real agent, its deliverable is
# checked on disk, and its human gate is HELD rather than rolling on; answering the gate starts
# the next phase; and the vault never returns a value through any surface.
set -uo pipefail

# Git Bash on Windows rewrites /container/paths into Windows paths; container paths must
# survive verbatim through docker exec.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
PROJECT="p9phases"
BASE="p9base"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }

mcp() { # mcp <tool> [json args]
  mcp_args="${2:-}"
  [ -z "$mcp_args" ] && mcp_args='{}'
  docker exec -w /opt/lightsout "$CONTAINER" node mcp-call.mjs "$1" "$mcp_args" 2>/dev/null
}
jq_get() { # jq_get <json> <expression over the parsed object>
  printf '%s' "$1" | docker exec -i "$CONTAINER" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const v = new Function("j", `return ${process.argv[1]};`)(j);
        console.log(v === undefined || v === null ? "" : String(v));
      } catch { console.log(""); }
    });
  ' "$2" 2>/dev/null
}

echo "== phase 9 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p9-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p9-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p9-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p9-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p9-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p9-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p9-tests.log
fi

docker compose up -d --build >/tmp/lo-p9-up.log 2>&1
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
docker cp scripts/mcp-call.mjs "$CONTAINER":/opt/lightsout/mcp-call.mjs >/dev/null 2>&1
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

echo "-- the builtin library ships in the image (BA-01)"
check "docker exec $CONTAINER test -f /opt/lightsout/builtin/agents/prompt-architect.yaml" \
  "builtin agent profiles are in the image"
check "docker exec $CONTAINER test -f /opt/lightsout/builtin/policies/curate.yaml" \
  "builtin policy packs are in the image"
check "docker exec $CONTAINER test -f /opt/lightsout/builtin/templates/full-development.yaml" \
  "builtin templates are in the image"
check "docker exec $CONTAINER test -d /opt/lightsout/scaffold/doc" \
  "the project scaffold moved out of templates/ (DESIGN §2)"

agents_json=$(mcp list_agents)
for id in prompt-architect contract-prober planner builder coordinator software-auditor \
          qa-engineer codebase-analyst answerer reviewer; do
  check "printf '%s' \"\$agents_json\" | grep -q '\"${id}\"'" "profile ${id} is loaded (BA-01)"
done

echo "-- templates (TP-01, TP-02, TP-03)"
templates=$(mcp list_templates)
for id in full-development quick-prototype knowledge-curation quick-answers; do
  check "printf '%s' \"\$templates\" | grep -q '\"${id}\"'" "template ${id} is usable (TP-02)"
done
rejected=$(jq_get "$templates" "j.rejected.length")
if [ "${rejected:-1}" = "0" ]; then
  ok "no builtin template is rejected (TP-03)"
else
  bad "no builtin template is rejected (TP-03) (got ${rejected})"
fi

echo "-- a curated knowledge base (KB-01)"
docker exec "$CONTAINER" mkdir -p "/workspace/knowledge/${BASE}"
docker exec "$CONTAINER" sh -c "cat > /workspace/knowledge/${BASE}/knowledge.yaml" <<YAML
name: Phase 9 test base
kind: technical
description: Facts the gate checks the agent was told.
tags: [phase9, gate]
updated: "2026-07-26"
YAML
docker exec "$CONTAINER" sh -c "cat > /workspace/knowledge/${BASE}/index.md" <<'MD'
- rules.md: the one rule this project must respect
MD
docker exec "$CONTAINER" sh -c "cat > /workspace/knowledge/${BASE}/rules.md" <<'MD'
# Rules

The magic word for this project is PLUMBAGO. Any document you write must contain it.
MD
docker restart "$CONTAINER" >/dev/null 2>&1
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done

knowledge=$(mcp list_knowledge)
check "printf '%s' \"\$knowledge\" | grep -q '\"${BASE}\"'" "the knowledge base is loaded (KB-01)"
doc=$(mcp read_knowledge "{\"baseId\":\"${BASE}\",\"file\":\"rules.md\"}")
check "printf '%s' \"\$doc\" | grep -q 'PLUMBAGO'" "read_knowledge returns a document (KB-04)"
escape=$(mcp read_knowledge "{\"baseId\":\"${BASE}\",\"file\":\"../../vault.yaml\"}")
check "printf '%s' \"\$escape\" | grep -q '\"ok\": false'" \
  "read_knowledge refuses a path outside the base"

echo "-- the vault never returns a value (VT-03)"
docker exec "$CONTAINER" sh -c "cat > /workspace/vault.yaml" <<'YAML'
entries:
  - id: p9-sandbox
    label: Phase 9 sandbox
    base_url: https://sandbox.invalid/api
    auth: bearer
    test_only: true
    scope: ["*"]
    fields:
      token: "never-leaves-the-vault"
YAML
vault=$(mcp list_vault)
check "printf '%s' \"\$vault\" | grep -q 'p9-sandbox'" "list_vault lists the entry (VT-01)"
check "! printf '%s' \"\$vault\" | grep -q 'never-leaves-the-vault'" \
  "list_vault never returns a value (VT-03)"
api_vault=$(curl -fsS "http://127.0.0.1:${PORT}/api/vault" 2>/dev/null)
check "! printf '%s' \"\$api_vault\" | grep -q 'never-leaves-the-vault'" \
  "the HTTP API never returns a value either (VT-03)"

echo "-- a project from full-development (TP-05, KB-03, PM-07)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}"
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB);
  const id = process.argv[1];
  db.prepare("DELETE FROM project_phases WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM project_knowledge WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM doubts WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM decisions WHERE project_id = ?").run(id);
' "$PROJECT" >/dev/null 2>&1

created=$(mcp create_project "{\"name\":\"${PROJECT}\",\"template\":\"full-development\",\"knowledge\":[\"${BASE}\"]}")
phase_count=$(jq_get "$created" "j.phases")
if [ "${phase_count:-0}" = "6" ]; then
  ok "create_project materialised the six phases (TP-05)"
else
  bad "create_project materialised the six phases (TP-05) (got '${phase_count}')"
fi
check "printf '%s' \"\$created\" | grep -q '\"${BASE}\"'" "the knowledge base is attached (KB-03)"

phases=$(mcp list_phases "{\"projectId\":\"${PROJECT}\"}")
first_ref=$(jq_get "$phases" "j.phases[0].ref")
if [ "$first_ref" = "shape-the-prompt" ]; then
  ok "the phases are in template order (TP-06)"
else
  bad "the phases are in template order (TP-06) (first is '${first_ref}')"
fi
check "printf '%s' \"\$phases\" | grep -q '\"gate\": \"human\"'" "the prompt phase carries a human gate (TP-01)"

curation=$(mcp create_project "{\"name\":\"p9curation\",\"template\":\"knowledge-curation\"}")
check "printf '%s' \"\$curation\" | grep -q '\"ok\": false'" \
  "a curation project without a writable base is refused (KB-05)"

echo "-- running the first phase for real (BA-04, TP-07)"
launched=$(mcp launch_phase "{\"projectId\":\"${PROJECT}\",\"phase\":\"shape-the-prompt\"}")
check "printf '%s' \"\$launched\" | grep -q '\"taskId\"'" "launch_phase created the phase's task"

gate_ref=""
for _ in $(seq 1 90); do
  sleep 5
  phases=$(mcp list_phases "{\"projectId\":\"${PROJECT}\"}")
  first_status=$(jq_get "$phases" "j.phases[0].status")
  [ "$first_status" = "failed" ] && break
  if [ "$first_status" = "done" ]; then
    status=$(mcp project_status "{\"projectId\":\"${PROJECT}\"}")
    gate_ref=$(jq_get "$status" "j.doubts.length ? j.doubts[0].ref : ''")
    [ -n "$gate_ref" ] && break
  fi
done
echo "  INFO  first phase status: ${first_status:-unknown}"

if [ "$first_status" = "done" ]; then
  ok "the first phase finished and its deliverable was found on disk (BA-04)"
else
  bad "the first phase finished (got '${first_status:-unknown}')"
fi
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/doc/PROMPT.md" \
  "the deliverable doc/PROMPT.md exists"
check "docker exec $CONTAINER grep -qi plumbago /workspace/projects/${PROJECT}/doc/PROMPT.md" \
  "the agent read the curated knowledge it was given (KB-04)"

if [ -n "$gate_ref" ]; then
  ok "the human gate is open and holding (TP-01) (${gate_ref})"
else
  bad "the human gate is open and holding (TP-01)"
fi
second_status=$(jq_get "$phases" "j.phases[1].status")
if [ "$second_status" = "pending" ]; then
  ok "the gate stopped the project instead of rolling on (§16.2)"
else
  bad "the gate stopped the project instead of rolling on (got '${second_status}')"
fi

echo "-- answering the gate continues the project (§16.2)"
if [ -n "$gate_ref" ]; then
  mcp answer_doubt "{\"projectId\":\"${PROJECT}\",\"doubtId\":\"${gate_ref}\",\"choice\":\"A\",\"note\":\"phase 9 gate\"}" >/dev/null
  moved=""
  for _ in $(seq 1 12); do
    sleep 5
    phases=$(mcp list_phases "{\"projectId\":\"${PROJECT}\"}")
    next_status=$(jq_get "$phases" "j.phases[1].status")
    if [ "$next_status" != "pending" ]; then moved="$next_status"; break; fi
  done
  if [ -n "$moved" ]; then
    ok "the next phase started once the gate was answered (${moved})"
  else
    bad "the next phase started once the gate was answered"
  fi
else
  bad "the next phase started once the gate was answered (no gate to answer)"
fi

echo "-- skip and ad-hoc phases (TP-07, TP-08)"
added=$(mcp add_phase "{\"projectId\":\"${PROJECT}\",\"title\":\"Extra check\",\"agentId\":\"reviewer\",\"instructions\":\"look again\",\"position\":5}")
check "printf '%s' \"\$added\" | grep -q 'adhoc-1'" "an ad-hoc phase is inserted with a reserved ref (TP-08)"
not_optional=$(mcp skip_phase "{\"projectId\":\"${PROJECT}\",\"phase\":\"plan\"}")
check "printf '%s' \"\$not_optional\" | grep -q '\"ok\": false'" \
  "a phase that is not optional cannot be skipped (TP-07)"

echo "-- the panel reads the same model (WP-10)"
api_phases=$(curl -fsS "http://127.0.0.1:${PORT}/api/projects/${PROJECT}/phases" 2>/dev/null)
check "printf '%s' \"\$api_phases\" | grep -q 'shape-the-prompt'" \
  "the HTTP API serves the phases (§12.1)"
api_templates=$(curl -fsS "http://127.0.0.1:${PORT}/api/templates" 2>/dev/null)
check "printf '%s' \"\$api_templates\" | grep -q 'full-development'" \
  "the HTTP API serves the templates (§12.1)"

# Guard against a gate that silently skips checks.
expected_checks=45
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 9: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
