#!/usr/bin/env bash
# Phase 10 verification (WP-02/10/11, AP-06..08, TP-04, SU-05).
#
# Green requires: an agent and a template created and edited through the browser's own API; a
# project created from that template and its phases driven from the panel alone; the refusals
# that live in the actions behaving the same on this surface as through MCP; the vault still
# never returning a value; and the panel itself parsing and serving every route it claims.
#
# The API is what the browser calls. Driving it with curl is driving the panel: the HTML posts
# these exact bodies to these exact URLs, and a screenshot would prove less.
set -uo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
BASE="http://127.0.0.1:${PORT}"
PROJECT="p10panel"
AGENT="p10-builder"
TEMPLATE="p10-flow"
KB="p10base"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }

get()  { curl -fsS "${BASE}$1" 2>/dev/null; }
send() { # send <METHOD> <path> [json]
  # The header only goes with a body, exactly as the panel's fetch does: Fastify refuses an
  # empty body that claims to be JSON, so sending it anyway would test a request no browser makes.
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H 'content-type: application/json' -d "$3" "${BASE}$2" 2>/dev/null
  else
    curl -sS -X "$1" "${BASE}$2" 2>/dev/null
  fi
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

echo "== phase 10 verification =="

echo "-- unit tests and typecheck"
if docker build --target test -t lightsout:test . >/tmp/lo-p10-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p10-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p10-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p10-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p10-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p10-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p10-tests.log
fi

docker compose up -d --build >/tmp/lo-p10-up.log 2>&1
for _ in $(seq 1 40); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 1
done
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"

echo "-- the panel is served and parses (ST-04)"
# Polled: the container was recreated a moment ago and `/health` answers before the static
# handler has anything to serve. A red for asking early is a red nobody believes later.
# The loop waits for the *content*, not for any answer: during a recreate the old container is
# still on the port for a moment, and a body that arrives is not evidence it is the new one.
panel=""
for _ in $(seq 1 30); do
  panel=$(curl -fsS "${BASE}/" 2>/dev/null)
  case "$panel" in *'data-r="/vault"'*) break ;; esac
  sleep 1
done
# Matched in the shell, not through a pipe: with `pipefail` on, `printf … | grep -q` reports a
# failure whenever grep matches *early* and leaves printf writing into a closed pipe. On a 127 KB
# page that is always, so the check was red while the page was perfect.
case "$panel" in
  *'data-r="/templates"'*) ok "the panel offers the new views" ;;
  *) bad "the panel offers the new views"; echo "  INFO  ${#panel} bytes served from ${BASE}/" ;;
esac
case "$panel" in
  *'data-r="/vault"'*) ok "the vault view is in the navigation" ;;
  *) bad "the vault view is in the navigation" ;;
esac
if docker run --rm -v "$(pwd)/panel:/p" node:22-slim node -e '
  const fs = require("fs");
  const html = fs.readFileSync("/p/index.html", "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new Function(script);
' >/tmp/lo-p10-panel.log 2>&1; then
  ok "the panel script parses"
else
  bad "the panel script parses"; tail -10 /tmp/lo-p10-panel.log
fi

echo "-- an agent, created and edited from the browser API (AP-06, AP-07)"
send DELETE "/api/agents/${AGENT}" >/dev/null
created=$(send POST /api/agents "{\"id\":\"${AGENT}\",\"name\":\"Panel builder\",\"engine\":\"claude\",\"policy\":\"default\",\"instructions\":\"Do exactly what the task says.\"}")
check "printf '%s' \"\$created\" | grep -q '\"ok\": *true'" "POST /api/agents creates a profile"
listed=$(get /api/agents)
check "printf '%s' \"\$listed\" | grep -q '${AGENT}'" "the profile appears in the library"
source=$(jq_get "$listed" "j.agents.find((a) => a.id === '${AGENT}').source")
if [ "$source" = "workspace" ]; then
  ok "it is a workspace profile (§2)"
else
  bad "it is a workspace profile (§2) (got '${source}')"
fi

edited=$(send PUT "/api/agents/${AGENT}" '{"name":"Panel builder v2","reasoning":"high"}')
check "printf '%s' \"\$edited\" | grep -q 'Panel builder v2'" "PUT /api/agents/:id edits it"
check "docker exec $CONTAINER grep -q 'Panel builder v2' /workspace/agents/${AGENT}.yaml" \
  "the edit landed in the workspace file, not just in memory"

# A builtin edited from the panel is cloned, never overwritten in the image (§2).
send PUT /api/agents/planner '{"reasoning":"medium"}' >/dev/null
check "docker exec $CONTAINER test -f /workspace/agents/planner.yaml" \
  "editing a builtin writes a workspace copy (AP-06)"
check "docker exec $CONTAINER grep -q 'reasoning: high' /opt/lightsout/builtin/agents/planner.yaml" \
  "the builtin in the image is untouched"
reverted=$(send DELETE /api/agents/planner)
# Read the field rather than grepping the text: the envelope is compact JSON and a pattern
# that depends on whitespace is a test of the serializer, not of the behaviour.
if [ "$(jq_get "$reverted" "j.revealedBuiltin")" = "true" ]; then
  ok "deleting the copy brings the builtin back"
else
  bad "deleting the copy brings the builtin back"; echo "  $reverted"
fi

echo "-- a template, created and edited from the browser API (TP-04)"
send DELETE "/api/templates/${TEMPLATE}" >/dev/null
# `planner`, not `prompt-architect`: the BA-01 pass removed that profile, and a template naming
# an agent that does not exist is rejected on load (TP-03) — which is what this fixture would be.
phases='[{"id":"shape","title":"Shape it","agent":"planner","gate":"human","deliverable":"doc/PROMPT.md","instructions":"Write doc/PROMPT.md from the request in the task spec. Keep it short."},{"id":"build","title":"Build it","agent":"'"${AGENT}"'","repeatable":true,"instructions":"Implement what doc/PROMPT.md asks for."}]'
tpl=$(send POST /api/templates "{\"id\":\"${TEMPLATE}\",\"name\":\"Panel flow\",\"phases\":${phases}}")
check "printf '%s' \"\$tpl\" | grep -q '\"ok\": *true'" "POST /api/templates creates a template"
check "get /api/templates | grep -q '${TEMPLATE}'" "it appears in the library"

# Reordering, inserting and removing are one edit to the phase array (§12.3).
reordered=$(send PUT "/api/templates/${TEMPLATE}" "{\"phases\":$(printf '%s' "$phases" | sed 's/Shape it/Shape it first/')}")
check "printf '%s' \"\$reordered\" | grep -q 'Shape it first'" "PUT /api/templates/:id edits the phases"
ghost=$(send PUT "/api/templates/${TEMPLATE}" '{"phases":[{"id":"x","title":"X","agent":"nobody","instructions":"y"}]}')
check "printf '%s' \"\$ghost\" | grep -q '\"ok\": *false'" \
  "a template naming an unknown agent is refused, not saved broken (TP-03)"

echo "-- a knowledge base from the browser API (KB-01)"
send DELETE "/api/knowledge/${KB}" >/dev/null
kb=$(send POST /api/knowledge "{\"id\":\"${KB}\",\"name\":\"Panel base\",\"kind\":\"technical\",\"tags\":[\"panel\"]}")
check "printf '%s' \"\$kb\" | grep -q '\"ok\": *true'" "POST /api/knowledge creates a base"
# The rule is stated as something the agent must act on, not as a fact it may ignore: the
# check downstream is whether the knowledge actually reached the prompt.
doc=$(send PUT "/api/knowledge/${KB}/doc" '{"file":"rules.md","content":"# Rules\n\nThis project has one naming rule: every document written for it must contain the word CINNABAR, which is the release codename. Put it in the first paragraph."}')
check "printf '%s' \"\$doc\" | grep -q '\"ok\": *true'" "PUT /api/knowledge/:id/doc writes a document"
check "get '/api/knowledge/${KB}/doc?path=rules.md' | grep -q CINNABAR" \
  "GET /api/knowledge/:id/doc reads it back"

echo "-- the vault, write-only values (VT-03)"
send DELETE /api/vault/p10-entry >/dev/null
entry=$(send PUT /api/vault/p10-entry '{"label":"Panel entry","auth":"bearer","test_only":true,"fields":{"token":"panel-secret-value"}}')
check "printf '%s' \"\$entry\" | grep -q '\"ok\": *true'" "PUT /api/vault/:id stores an entry"
check "! printf '%s' \"\$entry\" | grep -q 'panel-secret-value'" "the response carries no value"
check "! get /api/vault | grep -q 'panel-secret-value'" "GET /api/vault carries no value"
check "docker exec $CONTAINER grep -q 'panel-secret-value' /workspace/vault.yaml" \
  "the value did reach the vault file"

echo "-- a project created and driven from the panel alone (WP-10, TP-07)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}"
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.env.LO_DB);
  const id = process.argv[1];
  for (const t of ["project_phases", "project_knowledge", "doubts", "decisions"]) {
    db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
  }
' "$PROJECT" >/dev/null 2>&1

project=$(send POST /api/projects "{\"name\":\"${PROJECT}\",\"context\":\"goal: drive a whole project from the panel alone\\nactors: the phase 10 script\\ndone_when: the phases ran and the gate was answered from this surface\",\"template\":\"${TEMPLATE}\",\"knowledge\":[\"${KB}\"]}")
phase_count=$(jq_get "$project" "j.phases")
if [ "${phase_count:-0}" = "2" ]; then
  ok "POST /api/projects materialised the template's phases (TP-05)"
else
  bad "POST /api/projects materialised the template's phases (got '${phase_count}')"
fi

phases_json=$(get "/api/projects/${PROJECT}/phases")
check "printf '%s' \"\$phases_json\" | grep -q '\"ref\": *\"shape\"'" \
  "GET /api/projects/:id/phases serves them in order (TP-06)"
check "printf '%s' \"\$phases_json\" | grep -q '${KB}'" "the knowledge attachment is visible"

detached=$(send DELETE "/api/projects/${PROJECT}/knowledge/${KB}")
if [ "$(jq_get "$detached" "j.detached")" = "true" ]; then
  ok "a base can be detached from the panel"
else
  bad "a base can be detached from the panel"; echo "  $detached"
fi
reattached=$(send POST "/api/projects/${PROJECT}/knowledge" "{\"baseId\":\"${KB}\"}")
check "printf '%s' \"\$reattached\" | grep -q '\"ok\":true'" "and attached again (KB-03)"

in_use=$(send DELETE "/api/knowledge/${KB}")
if [ "$(jq_get "$in_use" "j.ok")" = "false" ]; then
  ok "deleting an attached base is refused with the reason (KB-03)"
else
  bad "deleting an attached base is refused with the reason (KB-03)"; echo "  $in_use"
fi

phase_id=$(jq_get "$phases_json" "j.phases[0].id")
adhoc=$(send POST "/api/projects/${PROJECT}/phases" "{\"title\":\"Extra\",\"agentId\":\"${AGENT}\",\"instructions\":\"look again\",\"position\":1}")
check "printf '%s' \"\$adhoc\" | grep -q 'adhoc-1'" "an ad-hoc phase can be inserted from the panel (TP-08)"

echo "-- refusals are the same on this surface as through MCP (§12.1b)"
send POST "/api/agents/${AGENT}/enabled" '{"enabled":false}' >/dev/null
disabled=$(send POST "/api/projects/${PROJECT}/phases" "{\"title\":\"Nope\",\"agentId\":\"${AGENT}\",\"instructions\":\"x\"}")
check "printf '%s' \"\$disabled\" | grep -q 'disabled'" \
  "a disabled agent is refused with the reason, not silently (AP-07)"
send POST "/api/agents/${AGENT}/enabled" '{"enabled":true}' >/dev/null
missing=$(send POST /api/phases/does-not-exist/launch '{}')
check "printf '%s' \"\$missing\" | grep -q '\"ok\": *false'" "an unknown phase answers an envelope, not a crash"

echo "-- launching a phase from the panel, for real"
request="Add a --version flag to the CLI that prints the version and exits 0. Nothing else. Do not ask about scope: anything not stated is out of scope."
expects="doc/PROMPT.md: what the flag does, what it prints, and what is out of scope"
launched=$(send POST "/api/phases/${phase_id}/launch" "{\"input\":\"${request}\",\"expects\":\"${expects}\"}")
check "printf '%s' \"\$launched\" | grep -q '\"taskId\"'" "POST /api/phases/:id/launch starts it (TP-07)"

gate_id=""
for _ in $(seq 1 90); do
  sleep 5
  phases_json=$(get "/api/projects/${PROJECT}/phases")
  first=$(jq_get "$phases_json" "j.phases[0].status")
  [ "$first" = "failed" ] && break
  doubts=$(get "/api/doubts?status=open&projectId=${PROJECT}")
  kind=$(jq_get "$doubts" "j.doubts.length ? j.doubts[0].kind : ''")
  id=$(jq_get "$doubts" "j.doubts.length ? j.doubts[0].id : ''")
  if [ "$kind" = "gate" ]; then gate_id="$id"; break; fi
  if [ -n "$id" ]; then
    choice=$(jq_get "$doubts" "j.doubts[0].recommendation || 'A'")
    echo "  INFO  answering ${kind} doubt with ${choice} from the panel API"
    send POST "/api/doubts/${id}/answer" "{\"choice\":\"${choice}\",\"note\":\"phase 10 gate\"}" >/dev/null
  fi
done
# Re-read after the loop: the poll reads the phases first and the doubts second, so on the
# iteration where the gate appears the phase status in hand is one read stale.
phases_json=$(get "/api/projects/${PROJECT}/phases")
first=$(jq_get "$phases_json" "j.phases[0].status")
echo "  INFO  first phase status: ${first:-unknown}"

if [ "$first" = "done" ]; then
  ok "the phase finished and its deliverable was found (BA-04)"
else
  bad "the phase finished (got '${first:-unknown}')"
fi
check "docker exec $CONTAINER grep -qi cinnabar /workspace/projects/${PROJECT}/doc/PROMPT.md" \
  "the agent was given the knowledge attached from the panel (KB-04)"

if [ -n "$gate_id" ]; then
  ok "the human gate is open and holding (TP-01)"
  answered=$(send POST "/api/doubts/${gate_id}/answer" '{"choice":"A","note":"go on"}')
  check "printf '%s' \"\$answered\" | grep -q '\"ok\": *true'" \
    "POST /api/doubts/:id/answer settles it from the panel (DO-04)"
  # Whichever phase is next in position order — the ad-hoc insert above sits between the
  # gated one and the build, so its index is not a constant.
  moved=""
  for _ in $(seq 1 12); do
    sleep 5
    phases_json=$(get "/api/projects/${PROJECT}/phases")
    next=$(jq_get "$phases_json" "j.phases.slice(1).find((p) => p.status !== 'pending')?.status || ''")
    if [ -n "$next" ]; then moved="$next"; break; fi
  done
  if [ -n "$moved" ]; then
    ok "the next phase started once the gate was answered (${moved})"
  else
    bad "the next phase started once the gate was answered"
  fi
else
  bad "the human gate is open and holding (TP-01)"
  bad "POST /api/doubts/:id/answer settles it from the panel (DO-04)"
  bad "the next phase started once the gate was answered"
fi

echo "-- both surfaces still agree (§12.0)"
docker cp scripts/mcp-call.mjs "$CONTAINER":/opt/lightsout/mcp-call.mjs >/dev/null 2>&1
mcp_phases=$(docker exec -w /opt/lightsout "$CONTAINER" node mcp-call.mjs list_phases "{\"projectId\":\"${PROJECT}\"}" 2>/dev/null)
mcp_first=$(jq_get "$mcp_phases" "j.phases[0].status")
if [ "$mcp_first" = "$first" ]; then
  ok "MCP and the HTTP API report the same phase state (got ${mcp_first})"
else
  bad "MCP and the HTTP API report the same phase state (${mcp_first} vs ${first})"
fi
check "docker exec $CONTAINER node -e '
  const Database = require(\"better-sqlite3\");
  const db = new Database(process.env.LO_DB, { readonly: true });
  const row = db.prepare(\"SELECT COUNT(*) AS n FROM events WHERE type = ? AND payload LIKE ?\").get(\"config.changed\", \"%panel%\");
  process.exit(row.n > 0 ? 0 : 1);
'" "every panel mutation is recorded with its actor (WP-11)"

# Guard against a gate that silently skips checks.
expected_checks=43
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 10: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
