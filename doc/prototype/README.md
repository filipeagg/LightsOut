# Panel prototype

`panel.html` is a static mockup of the web panel — the visual reference for DESIGN §12.3, ahead
of phases 7 and 10. One self-contained file, no build step, no dependencies, no network.

## Viewing it

Open `panel.html` in a browser. Chrome refuses to let automation drive `file://` pages, so for
screenshots there is a throwaway server:

```
node serve.mjs      # http://127.0.0.1:8899
```

## What it is

Every number, project, run and doubt is hand-written fake data at the top of the script. The data
shapes deliberately match the MCP tool contracts (§10.2) and the read endpoints (§12.1), so the
real panel can drop in `fetch()` calls without reshaping a single renderer.

Views: `#/` overview with the attention strip, `#/projects` the project list (WP-10), `#/p/<id>`
one project with its phase list and per-phase launch, re-launch and skip, plus doc, knowledge and
history tabs; `#/agents`, `#/templates`, `#/knowledge`, `#/vault` the configuration surface;
`#/health` and `#/setup`.

Every control that would change something opens the confirmation dialog and stops, with a note
naming the route in §12.1b it would post to. Nothing mutates, because there is nothing to mutate.

The scenario is chosen to show the states that matter rather than a happy path: one project mid-run
with a permission doubt, one paused on a verify failure with a functional doubt where the two
engines disagreed, one finished curation project, Codex unauthenticated, and one invalid agent and
one invalid template so the rejection paths are visible.

## Checking it

`node check.mjs` extracts the inline script and parses it (it writes `check.js`, git-ignored).
Route and dialog coverage was verified in a browser: all 14 routes render, all 15 dialogs open,
no console errors, no `undefined` or `NaN` reaching the DOM.
