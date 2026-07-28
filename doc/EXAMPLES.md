# Usage examples

Four realistic sessions, each based on a pattern this system has actually been driven through —
the domain is fictional (a small online retailer), not any real deployment, but the tools, the
launches and the shape of the outcome are exactly how it behaves.

## 1. A map with click-through detail, built from your own API

**The ask, typed in Claude Desktop:** *"Build a quick prototype: a map of our store network, click
a store to see its current stock levels, restock recommendations and open purchase orders. Talk to
our real inventory API."*

**What happens:**

```
create_project { name: "store-network-map", template: "none",
  templateReason: "one throwaway prototype, not a maintained project",
  context: "Internal prototype. Reads the real inventory API. No auth beyond the vault entry.
    Done when a store can be clicked and shows stock, recommendations and open orders." }
launch_task { projectId: "store-network-map", agentId: "builder",
  spec: "single-page prototype, our inventory API, map + click-through detail",
  expects: "a page that lists stores on a map and shows stock/recommendations/orders on click" }
```

A `builder` run writes one self-contained page under `src/`, calls the real API (a permission
doubt opens the first time it reaches outside the project — answered once, remembered for the rest
of the run), and finishes. `preview_start` serves it on a published port immediately; the URL comes
back in under a second and the server outlives the run, so the prototype is still there to click
through after the chat that built it has ended.

## 2. Turning a legacy API's scattered docs into a knowledge base

**The ask:** *"I have a wiki page, a Swagger export and nothing else for our billing API. Turn that
into a knowledge base an integration project can actually use, and tell me what's still missing."*

**What happens:** a `curate`-capable agent reads the raw material through an area (`add_area`) and
writes a machine-first analysis — gaps labelled `DOC`, `EMPIRICAL`, `VERIFIED`, `GAP` or
`DISCREPANCY`, each with a `resolves_in` pointing at the actual code that would settle it, never a
guess dressed as a fact. If the source code isn't reachable yet, the phase ends `blocked`, not
`ok` — an honest gap is the deliverable, not a bug. `doc/examples/ANALYSIS.machine-first.md` is
this exact document, in full.

Once the source arrives, relaunching the same phase resumes it — the base already knows what it
found the first time and does not repeat the reading.

## 3. A nightly digest that runs on its own

**The ask:** *"Every night, pull anything new from our competitors' changelogs and public pricing
pages, and fold it into a knowledge base I can ask questions against. I don't want to remember to
run this."*

**What happens:**

```
create_trigger { projectId: "market-watch", name: "nightly gather",
  every: { unit: "days", every: 1, hour: 23, minute: 0 }, phase: "gather",
  request: "collect anything new since yesterday", expects: "new documents in sources/, dated" }
```

`gather` and a second repeatable phase, `curate`, chain on their own: the trigger fires `gather` at
23:00, and finishing it launches `curate` immediately after, every night, with no one watching. A
missed night (container was off) runs once at boot rather than repeating the backlog. `list_doubts`
and the panel's timeline are where you'd notice if a night produced nothing worth curating.

## 4. An unattended export, start to finish

**The ask:** *"Write a script that logs into our reporting API with the stored credentials, pages
through this month's orders, and saves them to an Excel file. Run it and show me the result."*

**What happens:** the agent writes the script, reads the credential from the vault by name (never
by value — a value never travels through the conversation), authenticates, paginates until the
API's own `count` is satisfied, and writes the workbook with `openpyxl`. Rows are the same after
being read back from disk as before writing them — the run checks that itself rather than trusting
its own `ok`. Nothing here waits on a person: with the project set `unattended` (the default), a
permission question that isn't on the hard floor (credentials, publishing, deleting, reaching
outside the workspace) is judged and answered rather than parked, and the refusal — if there is
one — is handed back to the agent to adapt to, not left silent.

---

None of this requires knowing the tool names above by heart — `guide {}` lists every topic the
system can explain about itself, and the panel at `http://127.0.0.1:8484` shows the same picture a
browser away.
