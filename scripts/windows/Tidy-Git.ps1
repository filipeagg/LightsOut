# Clean up after git operations that could not unlink their temporary objects, and report the
# repository's real state (2026-07-27).
#
# Why this exists: running git against this repo from a container or a sandbox leaves
# `.git/objects/**/tmp_obj_*` behind, because the mount refuses the unlink. They are inert — git
# ignores stray files in the object store — but forty of them make it impossible to tell a broken
# object store from an untidy one at a glance. `git gc` does not remove them.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\Tidy-Git.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

$temps = @(Get-ChildItem -Path .git\objects -Recurse -Force -Filter 'tmp_obj_*' -ErrorAction SilentlyContinue)
$before = $temps.Count
foreach ($t in $temps) { Remove-Item -LiteralPath $t.FullName -Force -ErrorAction SilentlyContinue }
$after = @(Get-ChildItem -Path .git\objects -Recurse -Force -Filter 'tmp_obj_*' -ErrorAction SilentlyContinue).Count
Write-Output "tmp_obj: $before found, $after left"

Remove-Item -LiteralPath .git\_probe -Force -ErrorAction SilentlyContinue

Write-Output ''
Write-Output '--- fsck (silence is a healthy object store) ---'
git fsck --no-dangling --no-progress

Write-Output ''
Write-Output '--- files git reports as changed ---'
git status --short

Write-Output ''
Write-Output '--- of those, how many differ in more than line endings ---'
$real = git diff --ignore-cr-at-eol --name-only
if ($real) { $real } else { Write-Output '(none: every difference is CRLF vs LF)' }
