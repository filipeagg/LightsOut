#!/usr/bin/env bash
# Build (or refresh) the public mirror of this repository and push it to GitHub.
#
# This working copy is the private one: full git history, including doc/STATE.md and
# doc/DECISIONS.md (real hostnames and narrative about actual client work) and a handful of
# one-off debugging scripts tied to specific past incidents. None of that belongs in the public
# repository. The public repo is a *derived* artifact — a filtered clone with every path listed in
# publish-mirror-exclude.txt stripped out of every commit, not just the current tree — rebuilt
# from scratch each time this script runs, so the private working copy is never touched and never
# needs a remote of its own.
#
# Requires: git-filter-repo (pip install git-filter-repo --break-system-packages, or
# brew install git-filter-repo). Refuses to run without it rather than silently doing a partial
# job with `git filter-branch`.
#
# Usage:
#   ./scripts/publish-mirror.sh git@github.com:<owner>/LightsOut.git
#
# Safe to re-run: it always starts from a fresh clone of the current HEAD, so it can never carry
# over a previous mirror's state, and the push is forced because filter-repo rewrites every
# commit hash on each run.
set -euo pipefail

remote="${1:?usage: $0 <public-repo-remote-url>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# On Windows, pip installing git-filter-repo sometimes fails to write the .exe wrapper (a
# WinError 2 renaming it into place) while still installing the underlying module fine, so the
# package is importable but the command is not on PATH. Fall back to `python -m git_filter_repo`
# in that case rather than telling the user to reinstall something that already installed.
if command -v git-filter-repo >/dev/null 2>&1; then
  filter_repo() { git-filter-repo "$@"; }
elif command -v python3 >/dev/null 2>&1 && python3 -c "import git_filter_repo" >/dev/null 2>&1; then
  filter_repo() { python3 -m git_filter_repo "$@"; }
elif command -v python >/dev/null 2>&1 && python -c "import git_filter_repo" >/dev/null 2>&1; then
  filter_repo() { python -m git_filter_repo "$@"; }
else
  echo "ERROR: git-filter-repo not found (checked the command and the Python module)." >&2
  echo "  pip install git-filter-repo --break-system-packages" >&2
  echo "  (or: brew install git-filter-repo)" >&2
  exit 1
fi

echo "Cloning working copy into $work ..."
git clone --no-hardlinks "$here" "$work/mirror" >/dev/null
cd "$work/mirror"

echo "Stripping internal-only paths from every commit ..."
filter_repo --force \
  --paths-from-file "$here/scripts/publish-mirror-exclude.txt" --invert-paths

# Belt and braces: if an excluded path is ever re-added by hand after this point, it stays
# untracked in the mirror rather than silently slipping into the next push.
grep -v '^#' "$here/scripts/publish-mirror-exclude.txt" | grep -v '^\s*$' >> .gitignore
git add .gitignore
git -c user.email="mirror@local" -c user.name="publish-mirror" \
  commit -q -m "chore: exclude internal-only docs from the public mirror" || true

echo "Pushing to $remote (forced: history is rebuilt on every run) ..."
git remote add public "$remote"
git push --force public HEAD:main --tags

echo "Done. Verify on GitHub that doc/STATE.md and doc/DECISIONS.md are absent from every commit,"
echo "not just the latest one, before trusting this mirror with anything sensitive."
