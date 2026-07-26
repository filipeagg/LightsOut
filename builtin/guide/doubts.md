# guide :: doubts

meta.topic: doubts
meta.tools: list_doubts, answer_doubt, consult
meta.requirement: DO-01..06

## what_a_doubt_is

definition: a decision the agent cannot make alone. Not an error, not a failure, not a retry.
kinds: functional (the agent asked), permission (the policy had no answer and the run is held), gate (a phase finished and waits for a person), hard_rule (a binding rule is in the way).
mirror: every doubt appears in the project's QUESTIONS.md; the database is the source of truth and the file is regenerated.

## the_advisor

what: before opening a reversible functional doubt, the other engine is asked the same question with the same options.
auto_continue: if it agrees with the agent's recommendation above LO_ADVISOR_CONFIDENCE, the choice is recorded as a provisional decision, a git checkpoint is tagged, and the chain continues without you.
never_auto: irreversible classes (delete, push, credentials, publishing, outside the workspace), dependency installs, network, and anything naming a hard rule.
cap: MAX_AUTO_CONTINUE per task, so an agent and an advisor cannot agree in a loop.

## what_your_answer_teaches

allow: the command's shape is remembered and the same shape never asks again (PE-10).
never_remembered: credentials and publish_external — a wrong memory there cannot be taken back.
consequence: in those two classes the same question can come back; the doubt then says when you
answered it before and what you said, so it is a confirmation rather than a decision (DO-07).
review: list_learned_allows shows them with a use count; forget_learned_allow drops one.

## answering

answer_doubt { doubtId | ref, choice, note? }
choice: the option id the doubt offered (A, B, …). The note is why, and it is recorded in DECISIONS.md.
effect.functional: the task is requeued with the decision prepended, binding.
effect.permission: the held ACP request is answered — allow if the choice authorises it, otherwise refused with your note injected as a turn.
effect.gate: A launches the next phase; anything else stops the project where it is.
timeout: a permission doubt waits LO_PERMISSION_WAIT_HOURS, then the run is cancelled as interrupted and the doubt stays open.

## when_you_are_the_one_being_asked

read: the context, what it blocks, the options, the recommendation and the second opinion if there is one.
answer_the_question_asked: adding a new instruction in the note is how a task ends up doing something nobody planned. Use a new launch for new work.
if_the_options_are_wrong: answer the least bad one with a note saying so, or stop the chain and relaunch with a better request.

## consult

consult { projectId?, question, options? }: a second opinion on demand from the other engine, outside any run. Read-only, cheap, no side effects.
