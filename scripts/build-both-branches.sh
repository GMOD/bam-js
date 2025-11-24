#!/bin/bash

set -e

CURRENT_BRANCH=$(git branch --show-current)

echo "Current branch: $CURRENT_BRANCH"
echo "Building master branch..."

git checkout master
yarn build
mv esm esm_master

echo "Building $CURRENT_BRANCH branch..."
git checkout "$CURRENT_BRANCH"
yarn build
mv esm esm_thisbranch

echo "Build complete!"
echo "Master build: esm_master/index.js"
echo "Current branch build: esm_thisbranch/index.js"
