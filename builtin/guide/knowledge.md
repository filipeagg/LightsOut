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
source: a folder it reads from, when the base lives outside knowledge/

## enforcement

advisory: facts an agent weighs. It may disagree with them if the code says otherwise.
hard: rules an agent may not break. Injected whole, first, and never budgeted away. A doubt that names a hard rule (`hard_rule`) never sees the advisor and never auto-continues — only a person answers it (KB-11).
use_hard_for: decisions a person made and owns. Not for facts.

## attaching

attach_knowledge { projectId, baseId }: read-only, any number.
attach_knowledge { projectId, baseId, writable: true }: at most one base per project, and only a curation project needs it (KB-05). A hard-rule base is never writable.
consequence: writes into the writable base classify as knowledge_write and only the curate pack allows them; writes into any other base are denied outright.

## writing_documents

format: machine-first (BA-07) — key: value, tables, stable ids, a `source:` on every claim. Ask guide{topic:"documents"}.
index.md: one line per document saying what is in it. The injector reads the index first and then chooses.
one_subject_per_document: an agent opens what it needs; a single large file wastes the budget on everything it did not need.

## adopting_a_folder

adopt_knowledge: turns a folder the user already has in the workspace into a base, in place, without copying it (KB-08).
when: the material is already written and lives somewhere sensible; you only need the manifest and the index.
