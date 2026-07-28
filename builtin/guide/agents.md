# guide :: agents

meta.topic: agents
meta.tools: list_agents, write_agent, set_agent_enabled, delete_agent, reload_agents

## what_an_agent_is

definition: a profile, not a process. Engine, model, reasoning level, policy pack, instructions and a declared deliverable.
layering: eleven profiles ship in the image (ten that do work, plus the internal permission-judge); a file with the same id in workspace/agents/ shadows the builtin wholesale (TP-04).
edit_a_builtin: write_agent with its id clones it into the workspace with your changes. The builtin returns if the copy is deleted.

## fields

| field | values | notes |
|---|---|---|
| id | lowercase-with-dashes | the file name and the handle you launch with |
| name | free text | shown in both surfaces |
| engine | claude \| codex | must be installed and authenticated (health) |
| model | one of list_agents.models for that engine | never free text (AP-08) |
| reasoning | minimal \| low \| medium \| high | cost and depth |
| policy | a pack id: read \| build \| build-network | how far outside itself it may reach (guide{topic:"policies"}) |
| capabilities | list: knowledge_write, serve | what the pack denies and this profile is granted anyway. Curating knowledge needs `knowledge_write` |
| write_scopes | list of path prefixes | where inside the project it may write; omitted means anywhere in it |
| instructions | the agent's standing prompt | what it is for, how it works, what it must not do |
| deliverable | a path or a description | checked on disk when a phase closes (BA-04) |
| tags | list | grouping only |
| include | list of fragment ids | shared instruction blocks from workspace/agents/fragments |
| advisor | boolean | may be consulted as a second opinion (DO-02) |
| enabled | boolean | a disabled profile stays visible and refuses to run (AP-07) |

## the_model_is_a_launch_decision

rule: engine, model and reasoning on a profile are its **default**, not a fixed property (AP-09).
override: launch_task, launch_chain (per task) and launch_phase all accept engine, model and reasoning for that launch alone.
scope: nothing is written to the profile on disk; the next launch is back on the default.
catalog: list_agents returns `models` — the accepted values per engine. Pass one of those; anything else is refused at launch, with the list, before a run starts (OR-11).
engine_swap: passing engine without model drops the profile's model, because a Claude model name means nothing to Codex. Pass both when you swap engines.
health: launching onto an engine that is not authenticated is refused at launch, not attempted.
audit: an overridden run records config.changed {kind:"override"}, and the run row carries the engine and model that did the work.

example.cheap: `launch_task { agentId:"builder", model:"haiku", reasoning:"low", … }` — a mechanical edit.
example.deep: `launch_task { agentId:"builder", model:"opus", reasoning:"high", … }` — the same agent on a hard one.
example.chain: one chain, `model:"haiku"` on the mechanical tasks and nothing on the rest, which then use the profile's.

## the_builtins

count: ten — nine that do work, plus the internal permission-judge (BA-01).

planner: understands the request and writes doc/PLAN.md, one task per id. build.
builder: executes one piece of an unambiguous plan. build.
reviewer: reviews a change. codex, read, advisor.
software-auditor: audits delivered code into doc/AUDIT.md. codex, build, runs late.
qa-engineer: writes and runs tests, reports doc/QA-REPORT.md. build-network.
contract-prober: finds out how an external API really behaves, into doc/CONTRACTS.md. codex, build-network.
integrator: builds and runs an integration — calls the API and writes the client. build-network.
codebase-analyst: reads a system and writes the knowledge base. build + capabilities [knowledge_write].
answerer: answers a question from attached knowledge. read.
permission-judge: internal; one closed question before a gate wakes you. read, advisor (PE-11).

retired: prompt-architect (the planner does both jobs in one pass), coordinator (that is you), web-prototyper. A project of theirs still runs; new templates name the list above.

## writing_instructions_that_work

rule.1: say what it is for in one sentence, then what it must not do. The second is what stops drift.
rule.2: name the deliverable and its shape. Machine-first (BA-07); give a skeleton of keys.
rule.3: say where its facts come from and in what order of trust (code, then schema, then configuration).
rule.4: tell it what to do when it cannot know: raise a doubt, never infer.
rule.5: do not restate the protocol block. It is prepended to every prompt already.
antipattern: an instruction that describes tone. The engine has one; what it lacks is your constraints.

## worked_example

```json
write_agent {
  agentId: "migration-writer",
  name: "Migration writer",
  engine: "claude",
  model: "claude-sonnet-4-5",
  reasoning: "high",
  policy: "default",
  deliverable: "migrations/",
  instructions: "You write database migrations and nothing else.\n\nRead the models and the existing migrations before writing one. A migration that cannot be applied to the current schema is a defect, not a draft.\n\nNever edit an applied migration; add a new one. Never widen a CHECK constraint by editing it in place — rebuild the table the way SQLite documents.\n\nIf the change loses data, stop and raise a doubt with the options and what each one costs."
}
```

after: reload_agents is automatic (the loader polls), but you can force it. list_agents shows source: builtin | workspace.
