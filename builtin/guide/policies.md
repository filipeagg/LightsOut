# guide :: policies

meta.topic: policies
meta.requirement: PE-01..09
meta.note: packs are files in workspace/agents/policies/*.yaml; the seven builtins ship in the image

## how_a_permission_is_answered

step.1: the engine asks for permission before a sensitive action (the client declares no fs or terminal capability, so everything sensitive arrives as a request).
step.2: the action is classified (§7.1): the command is split into segments, each is matched, the worst class wins, and any path escape wins over everything.
step.3: the class is looked up in the project pack, then the agent's pack, then `default`. First hit wins.
step.4: the hard floor is applied and cannot be overridden.
step.5: the verdict is recorded with its rule source and latency. Every decision is auditable.

## the_classes

project_read, project_write, exec_check, script_exec, git_local, git_push, deps_install, network, delete, outside_workspace, credentials, publish_external, knowledge_write, other

script_exec: running the agent's own code. The body is read before it runs; a script that reaches the network or touches credentials is judged as that instead (PE-07).
other: an unmatched command. It reaches a human.

## the_verdicts

allow, deny, require_human, provisional
require_human: opens a permission doubt and holds the run until it is answered (or the slow clock expires).
provisional: allowed, recorded as a decision and tagged in git (PE-06).

## the_hard_floor_pe_03

outside_workspace: never allow. A declared area changes the *class* to project_read; it does not relax the floor.
credentials, publish_external, force push: never below require_human.
agents/, templates/, vault.yaml: always credentials, whatever the pack says.

## the_builtin_packs

| pack | for | shape |
|---|---|---|
| default | builder and most work | reads, writes, tests, own scripts, local git; dependencies and deletions ask a human; push and network denied |
| read-only | planner, auditor, prompt architect | writes confined to doc/ by write_scopes; no git history |
| no-write | answerer | reads and replies; writes and execution denied |
| test | qa-engineer | execution and loopback network; writes confined to the test directories |
| probe | contract-prober | network and execution; writes confined to probes/ and doc/; only test credentials resolve |
| curate | codebase-analyst | the only pack whose knowledge_write is allow, narrowed to the project's writable base |
| advisor | second opinions | everything read-only; the terminal denied |

## changing_what_an_agent_may_do

per_agent: write_agent with a different `policy`.
per_project: lightsout.yaml `policy.rules` overrides the agent's pack for that project only (PE-05).
write_scopes: a pack may confine writes to path prefixes; the scratch directory .lightsout/tmp/ is always writable (PE-08).
matchers: a pack may add regexes per class; they are merged onto the builtin table and matched per segment.
