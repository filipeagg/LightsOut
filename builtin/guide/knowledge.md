# guide :: knowledge

meta.topic: knowledge
meta.tools: list_knowledge, read_knowledge, write_knowledge, write_knowledge_doc, delete_knowledge_doc, delete_knowledge, adopt_knowledge, attach_knowledge

## what_a_base_is

definition: a folder of curated Markdown in workspace/knowledge/<id>, with a manifest (knowledge.yaml) and an index.md.
purpose: standing facts an agent should start with instead of rediscovering — a data model, an API's real behaviour, an organisation's conventions.
injection: an attached base is put into the prompt of every run of that project, budgeted by LO_KNOWLEDGE_BUDGET_CHARS (KB-06).

## manifest

id: lowercase-with-dashes
name: what a person calls it
kind: technical | organisational | product | process
enforcement: advisory (default) | hard
description: one line; it is what the injector shows first
tags: list
owner: who maintains it
source: a folder it reads its documents from, instead of its own

## enforcement

advisory: facts an agent weighs. It may disagree with them if the code says otherwise.
hard: rules an agent may not break. Injected whole, first, and never budgeted away. A doubt that names a hard rule (`hard_rule`) never sees the advisor and never auto-continues — only a person answers it (KB-11).
use_hard_for: decisions a person made and owns. Not for facts.

## attaching

attach_knowledge { projectId, baseId }: read-only, any number.
attach_knowledge { projectId, baseId, writable: true }: at most one base per project, and only a curation project needs it (KB-05).
consequence: writes into the writable base classify as knowledge_write; writes into any other base are denied outright.
who_may_write: an agent whose profile has `capabilities: [knowledge_write]` — `codebase-analyst` does. Every pack denies the class; the capability is what grants it. There is no "curate" pack (PE-14).

## which_base_may_be_written_into (KB-05, §17.1b)

may: a base whose documents live anywhere **inside** `knowledge/` — `knowledge/mercado` and `knowledge/hispatec/mercado` alike. Nesting is not a reason to refuse.
may_not: a base whose `source` points outside `knowledge/` — the user's own source tree, another project. That folder belongs to something else, which is the whole reason for the rule.
may_not: a base with `enforcement: hard`. An agent that can rewrite the rules binding it is not bound by them (KB-11c).
to_curate_material_that_lives_elsewhere: copy or move it under `knowledge/`, then adopt it.

## how_an_agent_actually_writes_one

told_where: the prompt of a run with a writable base carries "The knowledge base you write into" with `base.dir` as an absolute path.
with_the_shell: `cat > <base.dir>/index.md <<'MD' … MD`, or python. Not the structured edit tool.
why: `apply_patch`, `Edit` and `Write` scope themselves to the session's directory — the project — and refuse anything outside it before LightsOut is asked. That is the tool's rule, not a policy denial, and the prompt says so.
symptom_if_missed: documents in `<project>/knowledge/…`, a failed deliverable check, and a run.untracked event naming the mistake.

## writing_documents

format: machine-first (BA-07) — key: value, tables, stable ids, a `source:` on every claim. Ask guide{topic:"documents"}.
index.md: one line per document saying what is in it. The injector reads the index first and then chooses.
one_subject_per_document: an agent opens what it needs; a single large file wastes the budget on everything it did not need.

## adopting_a_folder

adopt_knowledge: turns a folder the user already has in the workspace into a base, in place, without copying it (KB-08).
when: the material is already written and lives somewhere sensible; you only need the manifest and the index.
