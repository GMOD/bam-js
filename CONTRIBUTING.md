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
