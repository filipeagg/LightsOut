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
| policy | a pack id: default, read-only, no-write, test, probe, curate, advisor | what it may do (guide{topic:"policies"}) |
| instructions | the agent's standing prompt | what it is for, how it works, what it must not do |
| deliverable | a path or a description | checked on disk when a phase closes (BA-04) |
| tags | list | grouping only |
| include | list of fragment ids | shared instruction blocks from workspace/agents/fragments |
| advisor | boolean | may be consulted as a second opinion (DO-02) |
| enabled | boolean | a disabled profile stays visible and refuses to run (AP-07) |

## the_builtins

prompt-architect: turns a rough request into doc/PROMPT.md. read-only.
planner: writes doc/PLAN.md, one task per id. read-only.
builder: executes one piece of an unambiguous plan. default pack.
reviewer: reviews a change. codex, read-only.
software-auditor: audits delivered code into doc/AUDIT.md. codex, read-only, runs late.
qa-engineer: writes and runs tests, reports doc/QA-REPORT.md. test pack.
contract-prober: finds out how an external API really behaves, into doc/CONTRACTS.md. probe pack, network.
integrator: builds and runs an integration — calls the API and writes the client. integrate pack: network, writes anywhere in the project, the vault.
codebase-analyst: reads a system and writes the knowledge base. curate pack.
answerer: answers a question from attached knowledge. no-write.
coordinator: owns a project across phases; usually embodied by you rather than launched.

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
