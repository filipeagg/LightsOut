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
#   DRY_RUN=1 ./scripts/publish-mirror.sh <same>   # filter and check, then stop before pushing
#
# The redaction list this reads (scripts/publish-mirror-redact.txt) is itself excluded from the
# mirror: it is a list of the names that must not be published.
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

# And rewriting the names that must not travel, in every blob and every commit message.
# Separate from the path list because the answer for doc/DESIGN.md is not to remove the file: it
# is the documentation, it has to be published, and its failure narratives name real systems.
# Fixing a name in the current tree is not enough either — filter-repo strips paths, not content,
# so the superseded commit would still carry it.
echo "Redacting internal names from every blob and message ..."
filter_repo --force \
  --replace-text "$here/scripts/publish-mirror-redact.txt" \
  --replace-message "$here/scripts/publish-mirror-redact.txt"

# Belt and braces: if an excluded path is ever re-added by hand after this point, it stays
# untracked in the mirror rather than silently slipping into the next push.
# The exclude file may use filter-repo's `glob:` / `literal:` prefixes; .gitignore understands the
# bare pattern, so strip the prefix on the way in (and drop `regex:` lines, which have no
# .gitignore equivalent).
grep -v '^#' "$here/scripts/publish-mirror-exclude.txt" | grep -v '^\s*$' \
  | grep -v '^regex:' | sed -e 's/^glob://' -e 's/^literal://' >> .gitignore
git add .gitignore
git -c user.email="mirror@local" -c user.name="publish-mirror" \
  commit -q -m "chore: exclude internal-only docs from the public mirror" || true

# The check, not the promise: every pattern is looked for again across the whole rewritten
# history — blobs and messages — and a survivor stops the push before a remote is even added.
# A redaction rule that quietly stops matching is worse than no rule at all, because the list
# reads like a guarantee.
echo "Verifying that nothing redacted survived ..."
patterns="$(grep -v '^#' "$here/scripts/publish-mirror-redact.txt" | grep -v '^[[:space:]]*$' \
  | sed -e 's/==>.*$//' -e 's/^literal://' -e 's/^glob://' -e 's/^regex://')"
survivors=0
while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  if git grep -I -l -F -e "$pattern" $(git rev-list --all) -- . >/dev/null 2>&1; then
    echo "  STILL PRESENT in a blob: $pattern" >&2
    survivors=1
  fi
  if git log --all --format='%B' | grep -q -F -e "$pattern"; then
    echo "  STILL PRESENT in a commit message: $pattern" >&2
    survivors=1
  fi
done <<EOF
$patterns
EOF
if [ "$survivors" -ne 0 ]; then
  echo "ERROR: refusing to push. Fix the redaction list, or the text it no longer matches." >&2
  exit 1
fi
echo "  clean."

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN set: stopping before the push. What the mirror would have been:"
  echo "--- last commits ---"
  git log --oneline -6
  echo "--- excluded paths still present (should be none) ---"
  git ls-files | grep -E '^(doc/(STATE|DECISIONS|PROJECT-INSTRUCTIONS)\.md|scripts/publish-mirror-redact\.txt)$' \
    || echo "  none"
  echo "--- what the redaction turned the DESIGN example into ---"
  git grep -n -E 'example\.com|acmeproduct' -- doc/DESIGN.md | head -8 || true
  exit 0
fi

echo "Pushing to $remote (forced: history is rebuilt on every run) ..."
git remote add public "$remote"
git push --force public HEAD:main --tags

echo "Done. Verify on GitHub that doc/STATE.md and doc/DECISIONS.md are absent from every commit,"
echo "not just the latest one, before trusting this mirror with anything sensitive."
