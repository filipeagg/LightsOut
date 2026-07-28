# guide :: previews

meta.topic: previews
meta.tools: preview_start, preview_stop, list_previews, preview_log
meta.rule: PV-02 — a development server is LightsOut's process, never the agent's terminal

## the_rule_that_matters

never: `npm run dev`, `vite`, `next dev`, `python -m http.server` as a task command. The policy denies them.
why: a server does not return. It holds the run's terminal open, produces no events, and the inactivity watchdog kills the run. The agent did nothing wrong and the run failed anyway.
instead: preview_start. LightsOut spawns it detached, publishes the port on the user's machine, and returns a URL in under a second.
lifetime: the preview outlives the run. That is the point — the person looks at the result after the agent has finished.

## preview_start

| field | required | notes |
|---|---|---|
| projectId | yes | |
| command | yes | the server command **without host or port**: both are set for you (PV-04) |
| port | no | one from the pool; refused if taken or outside it |
| cwd | no | a directory inside the project |
| ttlMinutes | no | default LO_PREVIEW_TTL_MIN, 120 |

returns: `{ id, port, url, command, normalised, alive }`. The url is `http://127.0.0.1:<port>` and opens in the user's own browser.

## what_is_rewritten_for_you

host: `--host 0.0.0.0`. A server on the container's localhost is unreachable however the port is published — this is the failure that looks like Docker being broken.
port: the allocated one, plus `--strictPort` where the tool has it, so a busy port is an error instead of a silent move outside the published range.
untouched: a command that already declares a host. Someone chose it.
recorded: what changed is on the preview row and in the preview.started event.

## cors

problem: a prototype fetching an API it was not served from is blocked by the browser before the request is made, and the page cannot fix it.
static: `node /opt/lightsout/dist/preview/serve.js --root dist --spa` — permissive CORS, preflight handled, no dependencies.
proxy: add `--proxy /api=http://upstream:8080` so the page talks to one origin.
vite: use its own `server.proxy`; the preview log is where a bad target shows up.

## when_it_does_not_load

step.1: `list_previews` — `alive: false` on a running row means the process died.
step.2: `preview_log { previewId }` — a missing dependency, a port conflict or a bad proxy target says so here.
step.3: a page that renders blank with no server error is usually a CDN link or a web font, fetched by the browser from a network the `build` pack never had.
step.4: the command the row shows is the one that ran, after normalisation. A package script gets its flags after `--`, and a program this system does not recognise gets none at all — it is steered with PORT and HOST (§21.3b).

## who_may_serve

capability: `serve` on the **profile** — `capabilities: [serve]`, not a pack (PE-14).
almost_nobody: preview_start owns the servers, so an agent needs this only to run one itself, which PV-02 says not to do.
a_prototype_needing_a_real_api: integration work — `integrator`, on `build-network`.
