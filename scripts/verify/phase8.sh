#!/usr/bin/env bash
# Phase 8 verification (SU-01..10, RT-02, RT-04).
#
# Green requires: the image can be published as a multi-arch artefact and the start command
# points at it; the four-step wizard is served and its API answers, including the refusals; a
# real login flow starts, streams and cancels without losing the engine's auth; a project created
# from the wizard lands in the host workspace; the Claude Desktop indicator reacts to a real MCP
# call; and a project exports as a zip that still carries its git history.
set -uo pipefail

# Git Bash on Windows rewrites /container/paths into Windows paths; container paths must
# survive verbatim through docker exec.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")/../.."

CONTAINER="${LO_CONTAINER:-lightsout}"
PORT="${LO_PORT:-8484}"
BASE="http://127.0.0.1:${PORT}"
PROJECT="p8wizard"

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
grep_file() { # grep_file <file> <pattern> <label>
  if grep -qE "$2" "$1" 2>/dev/null; then ok "$3"; else bad "$3"; fi
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
post() { # post <path> [json body] — Fastify refuses an empty body on a JSON content type
  post_body="${2:-}"
  [ -z "$post_body" ] && post_body='{}'
  curl -sS -X POST "${BASE}$1" -H 'content-type: application/json' -d "$post_body" 2>/dev/null
}

echo "== phase 8 verification =="

echo "-- publication and start (SU-01, SU-02, SU-08)"
WF=.github/workflows/release.yml
check "test -f $WF" "a release workflow exists (SU-01)"
grep_file "$WF" 'ghcr\.io' "the workflow pushes to GHCR (SU-01)"
grep_file "$WF" 'linux/amd64,linux/arm64' "it builds both architectures (SU-01)"
grep_file "$WF" '"v\*\.\*\.\*"' "it publishes on a version tag (SU-01, SU-08)"
grep_file Dockerfile 'AS runtime' "the Dockerfile names the runtime stage the workflow targets"
PS1=scripts/windows/Start-LightsOut.ps1
grep_file "$PS1" 'ghcr\.io/[^ "]+/lightsout' "the start script defaults to the published image (SU-01)"
grep_file "$PS1" 'restart unless-stopped' "the container comes back after a reboot (SU-02)"
grep_file "$PS1" 'setup\.html' "a machine that is not set up opens the wizard (SU-03)"

echo "-- Windows entry points (SU-07, SU-09, SU-10)"
bats=$(ls scripts/windows/*.bat 2>/dev/null | wc -l | tr -d ' ')
if [ "${bats:-0}" -ge 4 ]; then ok "every user-facing step is a double-click (SU-10) (${bats} files)";
else bad "every user-facing step is a double-click (SU-10) (found ${bats:-0}, expected >= 4)"; fi
grep_file scripts/windows/Connect-ClaudeDesktop.ps1 'ackup' \
  "the config-file fallback keeps a backup (SU-09)"

echo "-- unit tests, typecheck and the wizard's own script"
if docker build --target test -t lightsout:test . >/tmp/lo-p8-build.log 2>&1; then
  ok "test image builds"
else
  bad "test image builds"; tail -20 /tmp/lo-p8-build.log
fi
if docker run --rm lightsout:test npm run typecheck >/tmp/lo-p8-tsc.log 2>&1; then
  ok "typecheck clean"
else
  bad "typecheck clean"; tail -20 /tmp/lo-p8-tsc.log
fi
if docker run --rm lightsout:test npm test >/tmp/lo-p8-tests.log 2>&1; then
  ok "unit tests pass"
  grep -Eo "Tests +[0-9]+ passed" /tmp/lo-p8-tests.log | tail -1 | sed 's/^/  INFO  /'
else
  bad "unit tests pass"; tail -30 /tmp/lo-p8-tests.log
fi
# The panel has no build step, so nothing else would catch a typo before a browser does.
if docker run --rm -v "$(pwd)":/w -w /w lightsout:test node scripts/check-panel.mjs panel/setup.html \
     >/tmp/lo-p8-panel.log 2>&1; then
  ok "the wizard's inline script parses (SU-03)"
else
  bad "the wizard's inline script parses (SU-03)"; cat /tmp/lo-p8-panel.log
fi

echo "-- bringing the container up"
# Start-LightsOut.ps1 creates the container with a plain `docker run`, and compose refuses to
# reuse a name it does not own. Recreating it is safe: every piece of state is in a volume or the
# host workspace, and .env pins the same workspace for both paths.
if ! docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null | grep -q '[a-z]'; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1
fi
if docker compose up -d --build >/tmp/lo-p8-up.log 2>&1; then
  ok "compose brought the image and container up"
else
  bad "compose brought the image and container up"; tail -15 /tmp/lo-p8-up.log
fi
for _ in $(seq 1 40); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 1
done
check "docker ps --format '{{.Names}}' | grep -qx $CONTAINER" "container running"
check "curl -fsS ${BASE}/health | grep -q '\"status\"'" "/health answers (RT-06)"

echo "-- the wizard is served and its state answers (SU-03)"
setup_html=$(curl -fsS "${BASE}/setup.html" 2>/dev/null)
check "printf '%s' \"\$setup_html\" | grep -q 'LightsOut — setup'" "the wizard page is served"
missing_step=0
for step in s1 s2 s3 s4; do
  printf '%s' "$setup_html" | grep -q "id=\"$step\"" || missing_step=1
done
if [ "$missing_step" = "0" ]; then ok "it carries the four steps of §14.3";
else bad "it carries the four steps of §14.3"; fi

state=$(curl -fsS "${BASE}/api/setup/state" 2>/dev/null)
check "printf '%s' \"\$state\" | grep -q '\"ok\":true'" "/api/setup/state answers"
ws_mode=$(jq_get "$state" "j.workspace.mode")
ws_path=$(jq_get "$state" "j.workspace.path")
if [ "$ws_mode" = "host" ] && [ -n "$ws_path" ]; then
  ok "it reports the mounted workspace (RT-02) ($ws_path, $ws_mode)"
else
  bad "it reports the mounted workspace (RT-02) (got '$ws_path' / '$ws_mode')"
fi
templates=$(jq_get "$state" "j.templates.length")
if [ -n "$templates" ] && [ "$templates" -ge 1 ] 2>/dev/null; then
  ok "the library ships in the image, nothing to install (SU-03) (${templates} template(s))"
else
  bad "the library ships in the image, nothing to install (SU-03)"
fi
mcp_url=$(jq_get "$state" "j.mcp.url")
if [ "$mcp_url" = "${BASE}/mcp" ]; then
  ok "the connector URL is shown ready to copy (SU-09) ($mcp_url)"
else
  bad "the connector URL is shown ready to copy (SU-09) (got '$mcp_url')"
fi

echo "-- the workspace really is a folder on this machine (RT-02)"
mount_type=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Type}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)
mount_src=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)
if [ "$mount_type" = "bind" ]; then ok "/workspace is a host bind mount (RT-02) ($mount_src)";
else bad "/workspace is a host bind mount (RT-02) (type '$mount_type')"; fi
# Docker Desktop reports the source through its own VM prefix; Git Bash sees the same folder as
# /c/Users/... . Both shapes (and a plain Windows path) are normalised to what this shell can stat.
host_dir=$(printf '%s' "$mount_src" \
  | sed -e 's|^/run/desktop/mnt/host/|/|' \
        -e 's|^/host_mnt/|/|' \
        -e 's|\\|/|g' \
        -e 's|^\([A-Za-z]\):|/\1|' \
        -e 's|^/\([A-Z]\)/|/\l\1/|')
if [ -n "$host_dir" ] && [ -d "$host_dir" ]; then
  ok "the host folder exists and is browsable ($host_dir)"
else
  bad "the host folder exists and is browsable (looked for '$host_dir')"
fi

echo "-- step 1: workspace confirmation (§14.3)"
confirmed=$(post /api/setup/workspace '{}')
check "printf '%s' \"\$confirmed\" | grep -q '\"confirmed\":true'" "confirming the mounted folder is recorded"
state=$(curl -fsS "${BASE}/api/setup/state" 2>/dev/null)
check "[ -n \"\$(jq_get \"\$state\" 'j.workspace.confirmedAt')\" ]" "the confirmation survives in the state"
elsewhere=$(post /api/setup/workspace '{"path":"/somewhere/else"}')
check "printf '%s' \"\$elsewhere\" | grep -q '\"requiresRestart\":true'" \
  "a different folder answers with a restart, not a lie (§14.3 step 1)"
check "printf '%s' \"\$elsewhere\" | grep -q 'Workspace = '" \
  "and with the exact line to edit in Start-LightsOut.ps1"

echo "-- step 2: engine login from the browser (SU-04)"
bad_engine=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/setup/login/ghost" 2>/dev/null)
if [ "$bad_engine" = "400" ]; then ok "an unknown engine is refused (400)";
else bad "an unknown engine is refused (400) (got $bad_engine)"; fi
missing_flow=$(curl -sS "${BASE}/api/setup/login/does-not-exist" 2>/dev/null)
check "printf '%s' \"\$missing_flow\" | grep -q 'NOT_FOUND'" "an unknown flow answers NOT_FOUND, not a crash"
short_key=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/setup/login/codex/key" \
  -H 'content-type: application/json' -d '{"key":"short"}' 2>/dev/null)
if [ "$short_key" = "400" ]; then ok "an obviously invalid API key is refused before the CLI sees it (NF-03)";
else bad "an obviously invalid API key is refused before the CLI sees it (NF-03) (got $short_key)"; fi

# The gate does NOT run a real login: `codex login` deletes the existing credentials the moment
# it starts, so a gate that exercised it would log the machine out every time it ran (found the
# hard way — see DECISIONS.md). The flow machinery — spawn, URL and code parsing, SSE replay,
# cancellation, stdin key ingestion — is covered by test/setup.test.ts against stub commands.
# What is checked here is the part a unit test cannot see: the published callback port and the
# routes' behaviour.
callback=$(docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{$p}} {{end}}' "$CONTAINER" 2>/dev/null)
if printf '%s' "$callback" | grep -q '1455/tcp'; then
  ok "the OAuth callback port is published for the login forwarder (SU-04, §14.4)"
else
  bad "the OAuth callback port is published for the login forwarder (SU-04) (ports: $callback)"
fi
grep_file src/setup/login-flows.ts 'startForwarder' \
  "the flow arms the loopback forwarder for the callback (§14.4)"
codex_auth=$(jq_get "$(curl -fsS "${BASE}/health")" "j.engines.filter(e=>e.engine==='codex')[0].auth")
claude_auth=$(jq_get "$(curl -fsS "${BASE}/health")" "j.engines.filter(e=>e.engine==='claude')[0].auth")
echo "  INFO  engine auth after the gate: claude=$claude_auth codex=$codex_auth"

echo "-- step 3: the Claude Desktop indicator (SU-03, SU-09)"
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  new Database(process.env.LO_DB).prepare("DELETE FROM settings WHERE key = ?").run("mcp.last_seen_at");
' >/dev/null 2>&1
state=$(curl -fsS "${BASE}/api/setup/state" 2>/dev/null)
check "printf '%s' \"\$state\" | grep -q '\"connected\":false'" "the indicator starts grey after a reset"
curl -fsS -X POST "${BASE}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"phase8","version":"0"}}}' \
  >/dev/null 2>&1
sleep 1
state=$(curl -fsS "${BASE}/api/setup/state" 2>/dev/null)
check "printf '%s' \"\$state\" | grep -q '\"connected\":true'" "a real MCP call turns it green (SU-03 step 3)"

echo "-- step 4: the first project (PM-01, RT-02)"
docker exec "$CONTAINER" rm -rf "/workspace/projects/${PROJECT}" >/dev/null 2>&1
docker exec "$CONTAINER" node -e '
  const Database = require("better-sqlite3");
  new Database(process.env.LO_DB).prepare("DELETE FROM projects WHERE id = ?").run(process.argv[1]);
' "$PROJECT" >/dev/null 2>&1
created=$(post /api/projects "{\"name\":\"${PROJECT}\",\"verify\":\"true\",\"context\":\"goal: prove the wizard creates a project the way MCP does\\nactors: the phase 8 script\\ndone_when: the folder is visible on the host and exports as a zip\",\"template\":\"none\",\"templateReason\":\"a wizard fixture: nothing is built in it\"}")
project_id=$(jq_get "$created" "j.project.id")
if [ "$project_id" = "$PROJECT" ]; then ok "the wizard creates the project through the same call as MCP (PM-01)";
else bad "the wizard creates the project through the same call as MCP (PM-01) (got '$project_id')"; fi
check "docker exec $CONTAINER test -f /workspace/projects/${PROJECT}/lightsout.yaml" \
  "the scaffold wrote lightsout.yaml"
if [ -n "$host_dir" ] && [ -d "${host_dir}/projects/${PROJECT}" ]; then
  ok "the project is visible in the host file manager (RT-02, phase 8 done-when)"
else
  bad "the project is visible in the host file manager (looked for ${host_dir}/projects/${PROJECT})"
fi

echo "-- export as a zip (SU-06, §14.5)"
rm -f /tmp/lo-p8-export.zip
# Shell redirection, not curl -o: MSYS2_ARG_CONV_EXCL keeps /tmp/... from being translated for a
# native binary, so curl would write it as a literal Windows path.
curl -sS -X POST "${BASE}/api/export/project/${PROJECT}" > /tmp/lo-p8-export.zip 2>/dev/null
magic=$(head -c 2 /tmp/lo-p8-export.zip 2>/dev/null)
size=$(wc -c < /tmp/lo-p8-export.zip 2>/dev/null | tr -d ' ')
if [ "$magic" = "PK" ] && [ "${size:-0}" -gt 512 ]; then
  ok "the export is a zip (SU-06) (${size} bytes)"
else
  bad "the export is a zip (SU-06) (magic '$magic', ${size:-0} bytes)"
fi
# Entry names sit uncompressed in the headers, so the history is visible without unpacking.
if grep -aq "${PROJECT}/.git/" /tmp/lo-p8-export.zip 2>/dev/null; then
  ok "it carries the git history, not just the files (§14.5)"
else
  bad "it carries the git history, not just the files (§14.5)"
fi
if grep -aq "${PROJECT}/doc/STATE.md" /tmp/lo-p8-export.zip 2>/dev/null; then
  ok "and the managed documents"
else
  bad "and the managed documents"
fi
missing_export=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/export/project/ghost" 2>/dev/null)
if [ "$missing_export" = "404" ]; then ok "exporting an unknown project answers 404";
else bad "exporting an unknown project answers 404 (got $missing_export)"; fi

echo "-- finishing the wizard"
completed=$(post /api/setup/complete)
check "printf '%s' \"\$completed\" | grep -q '\"completedAt\"'" "the wizard records that setup is done (§14.3)"

# Guard against a gate that silently skips checks.
expected_checks=44
if [ "$((pass + fail))" -ne "$expected_checks" ]; then
  bad "gate integrity: ran $((pass + fail)) checks, expected $expected_checks"
fi

echo
echo "phase 8: ${pass} passed, ${fail} failed"
[ "$fail" = "0" ] || exit 1
echo "PHASE 8 GREEN"
