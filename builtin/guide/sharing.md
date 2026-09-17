# guide :: sharing

meta.topic: sharing
meta.tools: adopt_project, export_bundle, import_bundle
meta.requirement: PM-12, PM-13, PM-14, KB-14, VT-09

## the_question_it_answers

asked: a colleague has LightsOut installed and push access to the project's remote.
wanted: he works on the same project from his own machine.
wrong_answer: copying this machine's database, or `create_project` with the same name.
right_answer: he clones the repository and adopts it, and a bundle carries the rest.

## what_travels_and_how

| part | carried by |
|---|---|
| code, doc/, lightsout.yaml | git |
| brief, template, phases, areas, required ids | lightsout.yaml, in git |
| knowledge bases, agent profiles, templates | the bundle |
| vault values | nothing; the bundle names them |
| runs, events, costs, permission audit | nothing; one machine's history |

## adopt_project

use_when: the project exists somewhere else already.
never_use: create_project for it; that scaffolds a second project.
with_remote: `adopt_project {id, remote}` clones into projects/<id> first.
without_remote: the directory must already be there, holding lightsout.yaml.
writes: nothing into the directory, and no commit.
idempotent: adopting twice returns adopted: false.
answers: `missing` — bases, agent profiles, vault entries and areas absent here.

## export_bundle

holds: knowledge bases, workspace agent profiles, the workspace template, vault entry names.
holds_not: any file of the project. The code travels by git.
holds_never: a credential value. The writer scans its own output and aborts on one.
writes: `<workspace>/exports/<projectId>.lobundle`.
answers: the path on the user's own machine, and what the bundle requires.

## import_bundle

input: `import_bundle {path}` — the path to the .lobundle file.
order: knowledge, then agents and templates, then vault, then adoption.
overwrites: nothing. An existing base is reported, with whether it differs.
vault: entries named by the bundle are created with their fields empty.
then: it adopts the project, cloning the remote when there is no directory yet.
answers: what was written, what was left alone, what still needs configuring.

## you_received_a_bundle

first: `import_bundle {path}`. It installs the dependencies and creates the project in one call.
read_next: the answer carries `next` — what is left, in the order it has to be done, for this
  bundle on this machine. Follow that rather than this page: this page is the mechanism, `next`
  is the situation.
transport_clone: the bundle names a remote and the import clones it. Nothing else to do for code.
transport_copy: no remote. The project is still created — declared from the bundle (§9.7.2b) —
  and `missing.workdir` names where the directory has to go. Put it there, then `adopt_project`.
vault: entries arrive with empty fields. Fill them in the panel; a value never travels.
deps: do not run an install by hand. The first launch asks for a toolchain grant (ST-07).
engines: log in on this machine; they are your own accounts (SU-04).

## what_never_transfers

engine_login: his own account (SU-04).
toolchain: build output; it rebuilds itself (ST-07).
learned_allows: decisions he has not taken yet (PE-10).
linked_bases: a base reading a folder outside knowledge/ is named, not copied (KB-14).

## two_machines_one_remote

locks: SR-07 and OR-08 are locks inside one process. A second machine does not see them.
guaranteed: nothing is pushed on its own; push is manual by default (PM-05).
agreement: a branch each, or a branch per chain, merged by pull request.
conflict: two runs on one branch produce an ordinary git conflict.
