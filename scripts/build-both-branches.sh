#!/bin/bash

set -e

CURRENT_BRANCH=$(git branch --show-current)
BRANCH1="${1:-master}"
BRANCH2="${2:-$CURRENT_BRANCH}"

rm -rf esm_branch1 esm_branch2

echo "Building $BRANCH1 branch..."

git stash
git checkout "$BRANCH1"
yarn build
mv esm esm_branch1
echo "$BRANCH1" > esm_branch1/branchname.txt

echo "Building $BRANCH2 branch..."
git checkout "$BRANCH2"
yarn build
mv esm esm_branch2
echo "$BRANCH2" > esm_branch2/branchname.txt

echo "Build complete!"
echo "$BRANCH1 build: esm_branch1/index.js"
echo "$BRANCH2 build: esm_branch2/index.js"
git stash pop
