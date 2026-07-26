# guide :: areas

meta.topic: areas
meta.tools: list_areas, add_area, remove_area, resolve_path
meta.requirement: PE-09

## the_problem_it_solves

default: everything outside the project directory is `outside_workspace` and denied. The hard floor keeps it denied whatever the policy pack says (PE-02, PE-03).
symptom: an agent told where the code is cannot `ls` it, cannot copy it, and writes reports about being blocked.
fix: declare the directory once. The project may then read it.

## what_an_area_is

grant: read. Always read, only read.
copying: an agent may copy *from* an area *into* its project — the write lands in the project, which it already may write.
writing_into_it: refused, and the hard floor keeps it refused. There is no writable area and no flag to make one.
shape: a directory, or a single file when the material is one archive.

## what_can_never_be_one

| refused | why |
|---|---|
| the workspace root | an area is a part of the workspace, not all of it |
| agents/, templates/ | an agent may not read the system that runs it |
| vault.yaml | credentials reach the environment, never a read |
| knowledge/ | attach a base instead (KB-03) |
| another project's directory | one project is not a source of truth for another |
| a path that does not exist | refused at declaration, not silently at run time |

## using_it

add_area { projectId, path: "sources/efemis_django-master.zip", note: "the Django source under analysis" }
path: workspace-relative or an absolute container path under /workspace. Backslashes and trailing slashes are normalised.
effect: the areas are listed in every prompt of that project, so the agent knows what it may read.
remove_area { projectId, path }: withdraws it; the next run is denied again.
audit: both are `config.changed {kind:"area"}` events with the actor. Widening a boundary is a decision, recorded as one.

## paths

resolve_path { path }: translates container ⇄ this machine in either direction and says whether it exists (MC-08).
use_it: before telling a person where a file is. `/workspace/...` means nothing on their desktop.
