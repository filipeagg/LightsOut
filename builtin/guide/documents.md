# guide :: documents

meta.topic: documents
meta.requirement: BA-07, BA-08
meta.tools: list_docs, read_project_doc, read_doc, write_doc

## the_rule

scope: every Markdown file the system writes and reads back — phase deliverables, STATE/PLAN/DECISIONS/QUESTIONS/OPEN-QUESTIONS, knowledge documents.
not_in_scope: anything a human asked for as prose, and any other format. A prose document declares itself with `<!-- lightsout:audience=human -->` on its first line.
why: a 40 kB narrative deliverable costs every later run twice — once to write, once to read — and buries the facts inside it.

## the_shape

line: every line is `key: value`, a table row, a heading or a fenced block. No paragraphs.
keys: English snake_case, dotted for structure. Values may be in the project's language.
ids: stable (`f.1`, `G-3`) so another document points at them instead of repeating them.
sources: every claim carries `source:` — code:<path>:<line>, schema:<object>, doc:<path>#<id>, knowledge:<base>/<doc>, human:<doubt ref> — and `confidence:` when it is not derived from one.
supersede: the document is the current state, not a log. `meta.passes: 6` is all the history anyone needs.
tables: three or more items of the same shape.
size: no limit, and no licence to pad.

## skeleton

# ANALYSIS :: <project>
meta.doc: ANALYSIS
meta.updated: 2026-07-26
meta.passes: 2
meta.status: complete | partial | blocked
meta.blocked_on: <one key, when blocked>

## facts
f.1.claim: ...
f.1.kind: constraint | invariant | preference | accident
f.1.source: code:src/api/views.py:112
f.1.confidence: high

## gaps
| id | gap | needs | source |
|---|---|---|---|
| G-1 | ... | ... | doc/OPEN-QUESTIONS.md#q.4 |

## the_check

when: at task close, recorded as a `deliverable.lint` event; and again when the next run's prompt is built.
measures: share of structured lines, prose lines, longest paragraph, internal repetition. Bytes are reported and never judged.
consequence: a failing document never fails the phase. The next run on it is told to compact it and drop what repeats *before* adding anything.
seeing_it: list_docs carries the verdict per file.
