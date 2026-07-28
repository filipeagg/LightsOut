# ANALYSIS :: billing-api-integration

meta.doc: ANALYSIS
meta.updated: 2026-07-26
meta.passes: 3
meta.phase: analyse
meta.status: blocked
meta.blocked_on: sources_missing
meta.blocked_question: doc/OPEN-QUESTIONS.md#q.1
meta.delivered: audit of the knowledge base (gaps), reading plan, sources/ specification
meta.pending: analysis of the Django code (needs sources/)
meta.format: machine-first (LightsOut BA-07)

## repo

repo.sources_dir: absent
repo.py_files: 0
repo.tracked_files: 5 (doc/*.md, lightsout.yaml)
repo.commits: 1 (5ff4ad3 chore: scaffold project [lo:init])
repo.git_remote: none
repo.conclusion: sources/ is neither an uninitialised submodule nor an ignored path; the code was
  simply never versioned here
repo.source: verified:pass3

## blocker

blocker.code_location: /workspace/sources/billing_django-master
blocker.code_location_source: human:requester
blocker.code_inside_project: false
blocker.attempted: cp -r /workspace/sources/billing_django-master ./sources/billing_django-master
blocker.attempted_result: denied by policy
blocker.rule: any path outside the project directory is denied
blocker.resolution_needed: read permission outside the project, or a person copies the code in
blocker.decision_a: clone the Django project into sources/ and relaunch (provisional, 2026-07-26,
  not reopened)
blocker.relaunch_precondition: sources/ non-empty and conforming to sources_spec
blocker.question: doc/OPEN-QUESTIONS.md#q.1

## label_convention

label.DOC: asserted in the knowledge base with a documentary origin (wiki, API spec); not
  verified against code
label.EMPIRICAL: observed by calling the real API; a fact about behaviour, not about cause
label.VERIFIED: checked by the agent in this pass; operational record, not knowledge about the
  system
label.GAP: the base says nothing and an integrator needs it
label.DISCREPANCY: two documents in the base contradict each other, or one contradicts itself

## gaps.auth

| id | label | gap | resolves_in | question |
|---|---|---|---|---|
| A-1 | DISCREPANCY | login for integrations: one doc says `POST /auth/token` (v2 requires a captcha); another says use `token-v2` (v1 deprecated) | the authorisation view/serializer | doc/OPEN-QUESTIONS.md#q.2 |
| A-2 | GAP | token lifetime: access 1h, refresh 7d since last use, single use; looks like a standard JWT rotation scheme, unverified | `SIMPLE_JWT` in settings.py | — |
| A-3 | GAP | tenant model undocumented: `visibility_groups`, `role`, `is_admin` appear on more than one entity with no stated precedence | permission classes, `get_queryset` | — |

## gaps.api_conventions

| id | label | gap | resolves_in |
|---|---|---|---|
| B-1 | DISCREPANCY | PUT documented as full replace; empirically it accepts partial payloads | whether `partial=True` is forced on the update view |
| B-2 | GAP | list response envelope: pieces seen are `{count, data}` and `{count, data, deleted}` with no single documented shape | the pagination classes in use |

## reading_plan.code

plan.code.1: urls.py at the root and per app, plus routers -> entity x operation matrix (B-*)
plan.code.2: permission classes and get_queryset -> the authorisation model (A-3)
plan.code.3: serializers -> which fields are DB-required vs serializer-required (B-1)

## sources_spec

sources.path: /workspace/projects/billing-api-integration/sources/
sources.preferred_form: a full git clone (keeps history and branch, lets accidents be dated); a
  working-tree copy also works
sources.risk: a partial copy is the most likely failure mode and produces wrong labels, worse
  than not producing the analysis at all

| id | required | what | closes |
|---|---|---|---|
| S-1 | yes | manage.py and the full settings module, including per-environment overrides | A-2, A-3 |
| S-2 | yes | urls.py at the root and per app, with routers | B-*, custom actions |
| S-6 | yes | a dependency file with versions (requirements*.txt, pyproject.toml) | avoids labelling a library default as a design decision |
| S-9 | convenient | .env.example or a config template, with no real values | — |
| S-12 | exclude | secrets, .env with credentials, DB dumps, media/, compiled static, node_modules/ | add nothing and raise exposure |

## publishability

publish.gaps_section: no
publish.gaps_reason: these are well-formed questions, not answers; publishing them as facts would
  repeat the mistake the base exists to prevent
publish.gaps_use: a guided script for reading the code
publish.sources_spec: no; it is operational instruction for whoever populates sources/
publish.open_questions: doc/OPEN-QUESTIONS.md
