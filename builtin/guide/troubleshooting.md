# guide :: troubleshooting

meta.topic: troubleshooting
meta.first_move: health, then project_status or status_card, then get_history

## nothing_starts

symptom: launch returns queued: true and nothing runs.
check: another run holds the project (one run per project, SR-07), or LO_MAX_PARALLEL is reached across projects.
check: health.engines — an engine that is not authenticated refuses to launch with that reason (RT-04).
check: the agent profile is enabled (AP-07) and its engine matches an authenticated one.

## the_run_ended_and_i_do_not_know_why

read: project_status.lastRun.exitReason and .error, then get_history for the timeline.
status.verify_failed: the phase's verify command failed after the task. The chain is paused.
status.timeout | stuck: a watchdog fired. Recovery info is persisted; resume_chain requeues.
status.error with AUTH_REQUIRED: the engine's credentials expired mid-run. Reconnect the engine; the task is not at fault.
status.aborted: someone stopped it (stop_run or abort_run), or the adapter was cancelled.
sentinel_missing: the agent finished without the result block. The work may still be there; read the deliverable.

## the_agent_is_denied_something_it_needs

read: the perm.request and perm.verdict events in the timeline; each carries the class and the rule source.
outside_workspace: the material lives outside the project. Declare an area (guide{topic:"areas"}), do not weaken the pack.
other: an unmatched command reached a human. Add a matcher to the pack, or accept the gate.
deps_install: dependencies change the build for every later run; that gate is deliberate.
network: only the probe and test packs grant it.

## it_keeps_producing_the_same_document

cause: a relaunch with no new information reproduces the last pass.
fix: change the precondition (populate sources/, declare an area, answer the open doubt) or give a sharper `expects`. Relaunching alone is not a plan.

## the_deliverable_is_bloated_or_prose

read: list_docs shows the format verdict per file.
fix: the next run on that deliverable is already told to compact it. If it is not the next run you want, launch one whose expects is exactly that.

## where_is_that_file_really

resolve_path { projectId, path } or resolve_path { path }. Never guess the mapping (MC-08).

## the_panel

url: http://127.0.0.1:8484 — the live view, with the run timeline as it happens.
mcp: status_card is a snapshot on demand; Claude Desktop does not render live views pushed from a server.
