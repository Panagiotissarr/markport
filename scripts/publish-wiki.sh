#!/usr/bin/env bash
# Publish docs/wiki/*.md to this repository's GitHub wiki.
#
# WHY THE SOURCE LIVES IN THE REPO
# A GitHub wiki is a separate git repository (<repo>.wiki.git). It has no pull
# requests, no review, and no history next to the code it describes — so docs
# written only there drift silently and nobody sees the change. Keeping the
# pages in docs/wiki/ makes them versioned, reviewable and diffable in the same
# PR as the code; this script only mirrors them out.
#
# Editing a page in the browser edits the wiki repo directly. The next run of
# this script overwrites it. Edit docs/wiki/ instead.
#
# Usage: scripts/publish-wiki.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/docs/wiki"

if [ ! -d "$SRC" ]; then
  echo "ERROR: $SRC not found" >&2
  exit 1
fi

origin="$(git -C "$ROOT" remote get-url origin)"
slug="$(printf '%s' "$origin" | sed -E 's#(git@github\.com:|https://github\.com/)##; s#\.git$##')"
wiki_url="https://github.com/${slug}.wiki.git"

echo "  source: $SRC"
echo "  target: $wiki_url"

# GitHub creates <repo>.wiki.git when the first page is saved through the web
# UI. There is no API for wiki content and no way to create that repository
# from here, so say exactly what to do rather than failing with "not found".
if ! git ls-remote "$wiki_url" >/dev/null 2>&1; then
  cat >&2 <<EOF

ERROR: the wiki repository does not exist yet.

  1. open https://github.com/${slug}/wiki
  2. click "Create the first page" and save anything
  3. re-run this script — it replaces that page with docs/wiki/Home.md

EOF
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 "$wiki_url" "$tmp/wiki"

# Mirror, don't merge: the wiki repo's content is exactly docs/wiki/. Clearing
# everything except .git means a page deleted here also disappears there. No
# rsync — it is not installed everywhere (it isn't in this project's own CI
# image), and a doc-publishing script that fails on somebody's machine is worse
# than three lines of find.
find "$tmp/wiki" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp "$SRC"/*.md "$tmp/wiki"/

if [ -z "$(git -C "$tmp/wiki" status --porcelain)" ]; then
  echo "  no changes — wiki already matches docs/wiki/"
  exit 0
fi

git -C "$tmp/wiki" add -A
git -C "$tmp/wiki" \
  -c "user.name=${WIKI_AUTHOR_NAME:-$(git -C "$ROOT" config user.name || echo oryn)}" \
  -c "user.email=${WIKI_AUTHOR_EMAIL:-$(git -C "$ROOT" config user.email || echo oryn@localhost)}" \
  commit --quiet -m "docs(wiki): sync from docs/wiki @ $(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$tmp/wiki" push --quiet origin HEAD

echo "  published $(ls "$SRC" | wc -l | tr -d ' ') pages"
