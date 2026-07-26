# guide :: phases

meta.topic: phases
meta.tools: list_phases, launch_phase, skip_phase, add_phase, resume_chain

## what_a_phase_is

definition: the durable plan. A task is one attempt at it.
statuses: pending → running → done | failed | skipped
one_at_a_time: a phase runs, its task closes, the next pending phase starts — unless the phase has a human gate.
failure: a task that ends anything but ok fails its phase; a missing deliverable fails it too (BA-04). The chain pauses; nothing retries silently.

## launching_one

required: projectId, phase (its ref or id), input (the request this time), expects (what comes back) — OR-10.
refused_when: the phase is already running; it is done and not repeatable; its agent is missing or disabled.
repeatable: launch it again per subsystem, per question, per integration. Each launch carries its own input and expects.

## gates

gate.human: when the phase closes, a `gate` doubt opens instead of the next phase starting.
answering: answer_doubt with A (continue) launches the next phase; anything else leaves the project where it is, which is a decision, not a failure.
why: a gate means "a person has read the deliverable", nothing more. Questions belong in doubts, not in gates.

## skipping_and_inserting

skip_phase: only for a phase declared optional; sets skipped and moves on.
add_phase: inserts an ad-hoc phase at a position, shifting the rest down. Give it instructions and, if it produces something, a deliverable.

## when_a_phase_ends_badly

read: project_status.lastRun.exitReason and get_history.
common.deliverable_missing: the agent reported success without writing the file. Relaunch with a sharper `expects`.
common.verify_failed: the phase's verify command failed after the task. The chain is paused; fix or relaunch.
common.stuck: no activity for LO_INACTIVITY_MIN. The session was cancelled; resume_chain requeues it.
resume_chain: requeues every task that did not finish and leaves the ok ones alone.
