# guide :: triggers

meta.topic: triggers
meta.tools: list_triggers, create_trigger, write_trigger, delete_trigger

## what_a_trigger_is

definition: a launch with a clock on it. At the time it names it calls the same launch you would call by hand.
not_a_new_noun: no scheduler runs the work. The chain, the deliverable check, the gate and the doubt all behave exactly as they do for a launch a person made.
timezone: the container's clock. `list_triggers` and the panel say which one that is.

## what_it_launches

normal_case: a repeatable phase of the project (`phase`). The plan already says how the work is done; the trigger says when.
other_case: a free task (`agentId`, optional `title`), for recurring work with no plan around it.
required: `request` and `expects`, every time, like any other launch (OR-10). They are the same words on every firing, so write them as a standing instruction, not as today's.
refused: a phase that is not repeatable; both a phase and an agent; neither.

## cron

format: five fields — minute hour day-of-month month day-of-week. No seconds, no @daily.
supported: `*`, lists `1,15`, ranges `1-5`, steps `*/15` and `1-5/2`. 7 means Sunday, like 0.
examples:
  every weekday at seven: `0 7 * * 1-5`
  every fifteen minutes: `*/15 * * * *`
  first of the month, nine and five: `0 9,17 1 * *`
both_day_fields: when day-of-month and day-of-week are both restricted, either matching is enough. That is cron's rule and it surprises people.

## when_it_does_not_fire

busy: a run of that project is in flight. Skipped, recorded, not queued — one run per project (SR-07).
paused: the chain is paused, so something is waiting for a person. Adding work on top would bury it.
nothing_to_launch: the phase is not pending, or is not repeatable any more.
every_case: `last_result` says which, and an event records it. A trigger that has stopped working says so rather than going quiet.

## a_missed_firing

rule: at boot, the most recent slot that has passed runs once if nothing ran in it (TR-04).
not: five missed days do not become five runs. A trigger that has not fired in a month is a thing to look at, not to catch up.
floor: a slot older than the trigger itself never fires.

## unattended

effect: creating a trigger turns the project unattended (TR-07).
why: work that starts at 07:00 with nobody there must not stop at 07:01 on a permission gate. Anything the system cannot resolve becomes a doubt waiting in the morning.

## turning_one_off

write_trigger: `{triggerId, enabled: false}` keeps it and stops it.
delete_trigger: removes it. Use it when the work is over, not when you want a pause.
