# guide :: launching

meta.topic: launching
meta.rule: OR-10 — no agent runs without knowing what is asked and what is expected back

## the_contract

field.request: what you are asking for *this time*, in your own words. Required on every launch, including an intermediate phase of a template and a relaunch of a repeatable one.
field.expects: what comes back — the artefact, its shape, and how anyone decides it was met. Required.
field.brief: the project's standing context (PM-09), set at create_project. Not repeated per launch.
refusal: a launch without either is refused, naming what to add. This is deliberate: a phase title is not a task.

## expects_is_not_deliverable

deliverable: a path the system checks on disk when the phase closes (BA-04). Mechanical.
expects: the content contract, in words. What a person has an opinion about.
example.deliverable: doc/ANALYSIS.md
example.expects: "the entity x operation matrix as a table, one row per entity, with the source of each row; a gap without a source is not an answer"

## the_three_verbs

| tool | when | required |
|---|---|---|
| launch_task | one-off work outside a template | projectId, title, spec, expects, agentId |
| launch_chain | several tasks in order, one project | projectId, title, tasks[], expects per task |
| launch_phase | a project created from a template | projectId, phase, input, expects |

behaviour: all three return immediately with ids (MC-06). Poll project_status or status_card.
concurrency: one run per project; a second launch queues instead of failing (OR-08).

## optional_on_every_launch

needs: what the task needs to succeed (network, deps_install, execute, write, git, delete, knowledge_write). Checked against the agent's packs before the run starts; a mismatch is a refusal in one second, not a wasted run (PE-12).
grants: widen the policy for this run only. Recorded on the task, gone when it ends. Never reaches the hard floor.
engine / model / reasoning: the model for this launch only, overriding the profile (AP-09). One of list_agents.models for that engine; anything else is refused with the list.
checked_together: needs, the model and engine health are all checked in one pass, before a task row exists (OR-11).

## worked_example.task

```json
launch_task {
  projectId: "consultant-portal",
  agentId: "builder",
  title: "Wire the sync endpoint",
  spec: "Implement POST /api/sync per doc/PLAN.md task 4. Use the existing repository layer; do not add a dependency.",
  expects: "src/api/sync.ts and its test; npm test green; the endpoint returns 409 on a conflicting revision, which the test proves",
  level: "full"
}
```

## worked_example.phase

```json
launch_phase {
  projectId: "efemis-analysis",
  phase: "analyse",
  input: "Start with the authorisation layer: permission classes, get_queryset, visibility_groups.",
  expects: "doc/ANALYSIS.md extended with the authorisation section: one fact per line, each with code:<path>:<line>; every gap you cannot close listed with what would close it"
}
```

## say_what_the_task_needs

field.needs: the capabilities the work requires — network, deps_install, execute, write, git, delete, knowledge_write.
checked: against the agent's policy packs before the run starts (PE-12).
refusal: names what is missing, which agent's pack grants it, and the exact `grants` to pass. One second, not twenty minutes.
field.grants: widen the policy for this run only. Recorded on the task, gone when it ends, never reaches the hard floor of PE-03.
rule_of_thumb: if the task calls an API, installs something, or writes outside doc/, declare it.
vault: a project holding a vault entry with a base_url gets the network for that host automatically (VT-07) — you do not have to grant it.

example: launch_task { …, needs: ["network","deps_install"], grants: ["deps_install"], agentId: "contract-prober" }

## levels_and_limits

level.quick: LO_TIMEOUT_QUICK_MIN (30 min default). Exploration, small edits.
level.full: LO_TIMEOUT_FULL_MIN (90 min default). Real work.
watchdogs: a hard timer and an inactivity timer; expiry cancels the session and pauses the chain (SR-04).
cost: every run spends the user's subscription. Small specs, quick level while exploring.

## stopping

stop_run: cancels the ACP turn and ends the adapter now; the chain is left paused (OR-09).
abort_run: the same, plus the queued tasks are dropped and the chain is aborted.
letCurrentFinish: pass it to abort_run to drop only the queue and let the running agent finish.
after_a_stop: the task is `aborted`, the hygiene sweep still runs, and resume_chain can requeue what did not finish.
