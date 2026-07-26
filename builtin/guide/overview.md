# guide :: overview

meta.topic: overview
meta.audience: the MCP client (a model) driving LightsOut
meta.format: machine-first (BA-07)

## what_it_is

what: an orchestrator that runs coding agents unattended, in a container, over a folder on the user's machine
engines: claude (claude-agent-acp) and codex (codex-acp), each authenticated with its own subscription
surfaces: this MCP server, and a web panel on http://127.0.0.1:8484 — anything one can do the other can (MC-07)
you_are: the caller. You launch work, answer decisions and report state; you do not do the work yourself.

## the_four_nouns

| noun | what it is | lives in | created with |
|---|---|---|---|
| project | a folder in the workspace with its own git, docs and context brief | workspace/projects/<id> | create_project |
| phase | one durable step of a project's plan, with a frozen instruction and a deliverable | project_phases (DB) | a template, or add_phase |
| chain | the queue of tasks; one runs at a time per project | chains/tasks (DB) | launch_chain, or filled by phases |
| agent | a profile: engine, model, reasoning, policy pack, instructions | workspace/agents or builtin | write_agent |

related.template: a recipe of phases a new project is created from (list_templates, write_template)
related.knowledge: curated Markdown attached to a project and injected into prompts (list_knowledge, attach_knowledge)
related.area: a directory of the workspace a project may read outside itself (add_area)
related.vault: credentials resolved into the agent's environment, never into the conversation (list_vault)

## the_loop

step.1: create_project with a context brief (required, PM-09)
step.2: attach knowledge if the project needs standing facts
step.3: add_area if the material to read lives elsewhere in the workspace
step.4: launch_phase (template projects) or launch_task, always with request + expects (OR-10)
step.5: poll project_status or status_card; launches return immediately (MC-06)
step.6: list_doubts → answer_doubt when the run needs a human decision
step.7: read the deliverable with list_docs / read_project_doc

## rules_that_are_expensive_to_get_wrong

rule.1: every launch states the request of this run AND what is expected back. Refused otherwise (OR-10).
rule.2: a doubt is a decision the agent cannot make alone. It is not an error and not a failure.
rule.3: a denial is an answer. Policy refusals are mediated by the engine, not by a person; the agent adapts or raises a doubt.
rule.4: the workspace is the user's own folder. Ask resolve_path before telling a person where a file is (MC-08).
rule.5: documents the system reads back are machine-first: key: value, no prose (BA-07). Ask guide{topic:"documents"}.
rule.6: nothing is retried silently. A failed task pauses its chain and says why.
rule.7: launches are fire-and-forget. Poll; do not block.

## where_to_look_next

guide.launching: how to launch and what expects means
guide.agents: creating and editing agent profiles
guide.templates: writing a template of phases
guide.phases: running a project through its phases
guide.knowledge: curated bases, attachment and hard rules
guide.areas: reading material outside the project
guide.vault: credentials
guide.doubts: decisions, the advisor and gates
guide.policies: what an agent may do, and how to change it
guide.documents: the format every deliverable follows
guide.troubleshooting: what to do when something is stuck
