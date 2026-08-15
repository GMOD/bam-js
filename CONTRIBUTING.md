# Contributing

## Development

```sh
pnpm install
pnpm test
pnpm build
```

Use `pnpm version patch/minor/major` to release — it runs lint, format, types,
tests and build, regenerates CHANGELOG.md with git-cliff, then pushes the
version tag which triggers the publish workflow.

`docs/img/dataflow.svg` is generated from `docs/img/dataflow.dot` and
committed, since GitHub does not render DOT. If you edit the `.dot`,
re-render it in the same commit:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

Nothing checks this — graphviz is not a dependency and different versions emit
different SVG bytes, so a staleness check would fail on toolchain drift rather
than on a stale diagram.

## Benchmarks

`benchmarks/bam.bench.ts` compares two refs side by side rather than timing one
build, since a number with nothing to compare it against says very little.

```sh
pnpm bench                            # origin/main vs your current branch
BRANCH1=v8.9.0 BRANCH2=HEAD pnpm bench
pnpm benchonly                        # reuse whatever was built last time
```

`scripts/build-both-branches.sh` builds each ref in a throwaway git worktree
into `esm_branch1/` and `esm_branch2/`, so your checkout is never switched and
your local edits are left alone — which also means only committed work is
measured.

Every benchmark region is pinned by a record-count assertion in
`test/benchmark-regions.test.ts`. A query naming a contig its file does not have
returns `[]` before touching any of the code being measured, so it stays green
while timing nothing but `getHeader()` — seven of the ten cases were in exactly
that state before they were pinned
([ADR 0004](agent-docs/adr/0004-pin-benchmark-regions-with-a-test.md)). Change a
region and the test tells you what it now yields.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `--provenance` and
`id-token: write` permissions.

This repo is already configured. To set up a new package:
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag. Its notes are that version's CHANGELOG.md section, extracted by
`scripts/release-notes.sh` — run that with a version to preview what a release
will say.
