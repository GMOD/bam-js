#!/bin/bash

# Builds two refs into esm_branch1/ and esm_branch2/, which the comparison
# benchmark imports side by side.
#
# Each ref is built in a throwaway git worktree rather than by checking it out
# here, so the checkout you are sitting in is never switched and your local
# edits are left alone. That also means what gets benchmarked is each ref as
# committed - uncommitted work in this tree is not part of it.

set -euo pipefail

BRANCH1="${1:-origin/main}"
BRANCH2="${2:-$(git rev-parse --abbrev-ref HEAD)}"

ROOT=$(git rev-parse --show-toplevel)
SCRATCH=$(mktemp -d)
cleanup() {
  for wt in "$SCRATCH"/*; do
    [ -d "$wt" ] && git worktree remove --force "$wt" 2>/dev/null
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Note: uncommitted changes in this tree are not benchmarked." >&2
fi

build() {
  local ref=$1 out=$2 wt="$SCRATCH/$2"
  echo "Building $ref..."
  git worktree add --quiet --detach "$wt" "$ref"
  (cd "$wt" && pnpm install --frozen-lockfile --prefer-offline && pnpm build:esm)
  rm -rf "${ROOT:?}/$out"
  mv "$wt/esm" "$ROOT/$out"
  echo "$ref" >"$ROOT/$out/branchname.txt"
}

build "$BRANCH1" esm_branch1
build "$BRANCH2" esm_branch2

echo "Build complete!"
echo "$BRANCH1 build: esm_branch1/index.js"
echo "$BRANCH2 build: esm_branch2/index.js"
