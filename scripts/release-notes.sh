#!/bin/bash
# Print the CHANGELOG.md section for a version, for use as GitHub release notes.
#
# Usage: scripts/release-notes.sh v8.5.0   (the leading "v" is optional)
#
# The changelog is written by git-cliff during `pnpm version`, so by the time
# the tag exists the section is already committed — no need to re-derive the
# notes from git history in CI, which would want a full-history checkout.

set -euo pipefail

VERSION="${1#v}"

if [[ -z $VERSION ]]; then
  echo "usage: $0 <version>" >&2
  exit 2
fi

# Sections look like "## [8.5.0](https://.../compare/v8.4.2...v8.5.0) (date)".
HEADING=$(grep -m1 -F "## [$VERSION](" CHANGELOG.md || true)
if [[ -z $HEADING ]]; then
  echo "no CHANGELOG.md section for $VERSION" >&2
  exit 1
fi

# Everything between that heading and the next one, minus the heading itself —
# GitHub already shows the version as the release title — and minus the blank
# lines the template leaves at either end.
NOTES=$(awk -v ver="## [$VERSION](" '
  index($0, ver) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac)

# git-cliff renders a header for every tag (render_always), so a release whose
# commits were all skipped — a lone dependency bump, say — has an empty body.
if [[ -z $NOTES ]]; then
  NOTES="No user-facing changes."
fi

printf '%s\n' "$NOTES"

# The compare link the stripped heading was carrying.
COMPARE=$(grep -o 'https://github.com/[^)]*compare/[^)]*' <<<"$HEADING" || true)
if [[ -n $COMPARE ]]; then
  printf '\n**Full changelog**: %s\n' "$COMPARE"
fi
