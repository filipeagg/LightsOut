# guide :: templates

meta.topic: templates
meta.tools: list_templates, write_template, delete_template
meta.related: guide{topic:"phases"}

## what_a_template_is

definition: an ordered recipe of phases a project is created from. Copied into the project at creation and frozen there (TP-05).
consequence: editing a template never rewrites a running project. A project is a snapshot of a recipe, not a live reference to it.
builtins: full-development, quick-prototype, knowledge-curation, quick-answers.

## phase_fields

| field | required | meaning |
|---|---|---|
| id | yes | lowercase-with-dashes, unique in the template, never starting with `adhoc-` |
| title | yes | what a person reads |
| agent | yes | an agent id that exists and is enabled |
| instructions | yes | frozen into the project; the standing part of the task |
| deliverable | no | project-relative path, a glob, or `workspace:knowledge/...`; checked on disk when the phase closes |
| verify | no | a command that must pass after the phase's task |
| gate | no | auto (default) or human — a human gate stops and asks before the next phase |
| optional | no | may be skipped with skip_phase |
| repeatable | no | may be launched again, e.g. once per subsystem |

rule.workspace_deliverable: a `workspace:` deliverable is allowed only under knowledge/ and only when the template declares requires_writable_knowledge: true (KB-05).

## writing_instructions_for_a_phase

they_are_frozen: write what is true for every run of this phase; what changes per run arrives as `input` at launch (OR-10).
say: what to read, in what order; what to produce and in what shape; what to do when blocked.
do_not_say: the request of a particular run, a date, or anything that will be false next month.

## worked_example

```json
write_template {
  templateId: "api-integration",
  name: "API integration",
  description: "Probe an external API, plan against what it really does, build and test it.",
  phases: [
    { id: "probe", title: "Find out how the API behaves", agent: "contract-prober",
      deliverable: "doc/CONTRACTS.md", repeatable: true,
      instructions: "Call the API named in the request with the vault's test credentials. Record real requests and responses, status codes, pagination, auth behaviour and every place the documentation and the service disagree. Machine-first: one endpoint per id, payloads in fenced blocks. Never invent a URL or a token; a missing credential is a doubt." },
    { id: "plan", title: "Plan against what it really does", agent: "planner",
      deliverable: "doc/PLAN.md", gate: "human",
      instructions: "Read doc/CONTRACTS.md and the existing code. One task per id: what it changes, which files, the interface, the edge cases, how it is verified, what it depends on. An ambiguity is a doubt, not a guess." },
    { id: "build", title: "Build it", agent: "builder", verify: "npm test",
      instructions: "Execute doc/PLAN.md in order, one task at a time. Do not go beyond the plan; a change the plan does not name is a doubt." },
    { id: "qa", title: "Test it", agent: "qa-engineer", deliverable: "doc/QA-REPORT.md",
      instructions: "Cover the acceptance criteria and the edge cases of the plan, including the failure modes the contracts revealed. A failing test caused by the product is a finding, not something to fix." }
  ]
}
```

## after_writing

validation: a template that fails validation is listed as rejected with its reason and is never selectable (TP-03).
use: create_project { name, context, template: "api-integration" }.
ad_hoc: add_phase inserts one phase into a live project at a position (TP-08); its id is `adhoc-N`.
