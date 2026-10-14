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

`docs/img/dataflow.svg` is generated from `docs/img/dataflow.dot` and committed,
since GitHub does not render DOT. If you edit the `.dot`, re-render it in the
same commit:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

CI does not check that the SVG matches the `.dot`. Graphviz is not a dependency,
and different graphviz versions emit different SVG bytes, so a byte comparison
would fail when the graphviz version changed rather than when the diagram fell
out of date.

[docs/api.md](docs/api.md) is written by hand, and `test/apiDocs.test.ts` fails
when it misses an export of `src/index.ts`, a constructor option, or a public
member of `BamFile`, `HtsgetFile`, `BamRecord` or the option types. Document the
new name, or add it to the test's `undocumented` list with the reason it is
internal.

## Benchmarks

`benchmarks/bam.bench.ts` times two refs side by side, so each number has a
baseline to compare against.

```sh
pnpm bench                            # origin/main vs your current branch
BRANCH1=v8.9.0 BRANCH2=HEAD pnpm bench
pnpm benchonly                        # reuse whatever was built last time
```

`scripts/build-both-branches.sh` builds each ref in a throwaway git worktree
into `esm_branch1/` and `esm_branch2/`. The script never switches your checkout
or touches your local edits, so the benchmark measures only committed work.

A record-count assertion in `test/benchmark-regions.test.ts` pins every
benchmark region. A query naming a contig its file does not have returns `[]`
before touching any of the code being measured, so the benchmark stays green
while timing nothing but `getHeader()`. Seven of the ten cases were in exactly
that state before the test pinned them
([ADR 0004](agent-docs/architecture-decision-records/0004-pin-benchmark-regions-with-a-test.md)).
Change a region and the test tells you what it now yields.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `--provenance` and
`id-token: write` permissions.

This repo is already configured, and setting up a new package takes
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag. `scripts/release-notes.sh` copies the release notes from that version's
CHANGELOG.md section, so run the script with a version to preview a release's
notes.
