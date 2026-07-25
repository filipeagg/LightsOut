# Panel prototype

`panel.html` is a static mockup of the web panel — the visual reference for DESIGN §12.3, ahead
of phases 7 and 10. One self-contained file, no build step, no dependencies, no network.

## Viewing it

Open `panel.html` in a browser. Chrome refuses to let automation drive `file://` pages, so for
screenshots there is a throwaway server:

```
node serve.mjs      # http://127.0.0.1:8899
```

## Design system

Not invented here. The tokens come from published sources so the panel does not depend on
anyone's taste, mine included:

- **Neutral ramp:** Radix `slate` dark, using the steps for what they are meant for — 1 page,
  2 surface, 3 raised, 4 hover, 6/7/8 borders, 11 muted text, 12 text. Steps 11 and 12 are
  engineered to hit APCA Lc 60 and Lc 90 on step 2, so secondary text is legible by construction
  rather than by eyeballing a gray.
- **Borders** are translucent white (`#ffffff14` / `#ffffff24`), not solid gray, so they layer
  over any surface. Depth is surface steps plus a hairline; shadows exist only on things that
  actually float, at Vercel's 2–16% alpha.
- **Typography:** Geist Sans and Geist Mono, 14px base with px line-heights on the 4px grid, and
  Vercel's tracking rule — -4% at 24–32px, -2% at 14–20px, exactly 0 on body and labels. Two
  weights (400, 600) plus 500 for controls. Tabular figures with slashed zero wherever numbers
  stack or tick.
- **Accent** (Radix `iris`) is reserved for the primary action, the active nav item and the focus
  ring. Delete it and the panel still reads as itself, which is the test.
- **Status** uses Radix dark 3/6/9/11 for green, amber, red and blue, and never colour alone: every
  state carries an icon or a dot as well.
- **Controls:** 40px medium, 32px small, 6px radius; 12px on cards and dialogs. Spacing is 8 inside
  a group, 16 between groups, 32–40 between sections. Card padding 24.
- **Icons** are one inline set at one stroke width. No emoji: they render differently per platform
  and carry no stroke weight.

Sources: `vercel.com/design.dark.md` (the Geist dark token dump),
`radix-ui.com/colors/docs/palette-composition/understanding-the-scale`, and the Radix colour
packages themselves.

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
