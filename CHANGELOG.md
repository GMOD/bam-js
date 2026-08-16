## [8.11.0](https://github.com/GMOD/bam-js/compare/v8.10.0...v8.11.0) (2026-08-16)

### Bug Fixes

- Identify streamed records by ordinal, not by a hash of their bytes ([2ba106b](https://github.com/GMOD/bam-js/commit/2ba106b26187a9428c06d5674f4db0272c354d5e))
- Open the read-ahead only once a read comes back full-length ([baea625](https://github.com/GMOD/bam-js/commit/baea6253b53e7be332a0ee7e002dc1f97ff4f219))

### Documentation

- Fix stale paths in the dataflow.dot header ([b0b5190](https://github.com/GMOD/bam-js/commit/b0b51906926d6bf5dfb9218da831f57947107790))
- Give the worker pool its own legend color, and describe it ([67d42ed](https://github.com/GMOD/bam-js/commit/67d42ed7cab0e1851461b9d3e594641feafde2f4))
- Put the prose in the active voice ([5887a16](https://github.com/GMOD/bam-js/commit/5887a16dac81630cabdf0748103b555e3177fa4e))
- Note the whole pipeline can run in a worker, and trim the prose ([cc2ec81](https://github.com/GMOD/bam-js/commit/cc2ec815ac07b1c7cafaa74e0526b9bee783f7dc))
- Put fetchReferenceSequence on the dataflow diagram ([dd09b58](https://github.com/GMOD/bam-js/commit/dd09b58e5d80f453d5553fde1c89da669310aed8))
- Correct the release command in CONTRIBUTING, and its voice ([2395a5c](https://github.com/GMOD/bam-js/commit/2395a5c1f56bf42808d06b44ec8b1dae48e373cb))

### Features

- StreamBamRecords, an index-free whole-file walk (closes #125) ([b60098e](https://github.com/GMOD/bam-js/commit/b60098ed93b9893f585e57445814235c9e2eafba))

### Performance Improvements

- Inflate on a worker pool, and keep several window reads in flight ([c1a27ff](https://github.com/GMOD/bam-js/commit/c1a27ffa9613a180228e33998febd55618bb63bb))

## [8.10.0](https://github.com/GMOD/bam-js/compare/v8.9.0...v8.10.0) (2026-08-15)

### Chores

- Keep agent worktrees out of the toolchain's way ([2b04359](https://github.com/GMOD/bam-js/commit/2b04359ed591f854fe82f2038251f1745c4c864b))
- Build each ref in a worktree ([1739194](https://github.com/GMOD/bam-js/commit/17391942e03e440f5c3c7b6b1dc33515bb7da5eb))

### Documentation

- 0019's two blockers have an answer — a canonical partition ([a3ccad0](https://github.com/GMOD/bam-js/commit/a3ccad0f6fa928eb030f3f046a7c76cb1dedd072))
- A data-flow diagram, and where the wasm boundary sits ([719087e](https://github.com/GMOD/bam-js/commit/719087ec60379031f1679ea051cf4fae91806f99))
- Stop saying 70-90% twice, and note how to re-render the diagram ([5cf013c](https://github.com/GMOD/bam-js/commit/5cf013ced70f370c0d573751a2114d188a1b1a95))
- 0022's numbers now come from a benchmark that exists ([445b3e6](https://github.com/GMOD/bam-js/commit/445b3e66f66a550e74c4b0dad3a9d6a893e613bf))
- Trim the README, moving the dataflow prose into docs/ ([94c8ab9](https://github.com/GMOD/bam-js/commit/94c8ab9e50234f2c929e0fe4d161a1675e4c80da))
- Simplify the diagram and label the legend ([ec38f7e](https://github.com/GMOD/bam-js/commit/ec38f7eca683629526f811c7914e9ba46f2b33a7))
- Say what the wasm actually does instead of 'only ever inflate' ([684ddd4](https://github.com/GMOD/bam-js/commit/684ddd42aaf8df112cc3f4913b8d82eaf6a63a3a))
- Let the wasm paragraph read as prose ([cdde945](https://github.com/GMOD/bam-js/commit/cdde94581988d9a4af340f26945c6c9fba2da8fc))
- Keep the dataflow diagram in docs/, not the README ([6962a70](https://github.com/GMOD/bam-js/commit/6962a7024c5d8d55b2bd7b5804248bfebe121718))
- README title, citation and section order match the sibling repos ([2d4dce0](https://github.com/GMOD/bam-js/commit/2d4dce0242bf4150de79694c796830feb324fdd1))
- Spell out what a cold query is and that 70-90% is time ([cb92635](https://github.com/GMOD/bam-js/commit/cb926356e64fe40987d97c5734a9ee4b8a8233b9))
- Say 70-90% of the time spent answering an uncached query ([d3c0522](https://github.com/GMOD/bam-js/commit/d3c05220e540906ab8522fb8807199bf3837060f))
- Explain CIGAR and MD, and tighten README prose ([32616b1](https://github.com/GMOD/bam-js/commit/32616b1481cbf825e677cceda7cbefe6f2c1c98a))
- Tighten caching.md and link the ADRs inline ([c29987a](https://github.com/GMOD/bam-js/commit/c29987a3ebabdf9e7548b2770891cf7a33f61d39))
- Show getMismatches output upfront, drop the duplicate snippet ([c150aa3](https://github.com/GMOD/bam-js/commit/c150aa36ad064e053d416867c37ab8a084512432))
- One mismatch example per doc, at the top of the section ([2781054](https://github.com/GMOD/bam-js/commit/2781054b0b52da4a75638f0a7de7fd0896447ab9))
- Note the chunk cache in the README, stop naming the pairing options ([10a6542](https://github.com/GMOD/bam-js/commit/10a654288e6214930ce0d35d92100a486f6b882a))
- Add optimizations.md, mirroring tabix-js ([5067e9b](https://github.com/GMOD/bam-js/commit/5067e9baa31baf118556a94836d395ce28803872))
- Say what "70-90%" is a share of, and record the parked cache-key waste ([5d41e3d](https://github.com/GMOD/bam-js/commit/5d41e3de6a32680d9cf22f0ee1f9e3964669c1b8))
- Name transferables where the pool is described, and tighten ([c498867](https://github.com/GMOD/bam-js/commit/c498867498a04f3f415e58ae2a64e2b56135860b))
- Fill the API gaps, and cut what two docs said twice ([fcbef2f](https://github.com/GMOD/bam-js/commit/fcbef2f9cafb329a9d34eb271f82e0f41fcb34d4))

### Features

- Export the Chunk type, and document benchmarks in CONTRIBUTING ([d5bf9c9](https://github.com/GMOD/bam-js/commit/d5bf9c9449e9ba258b37837206b88074e7881424))

### Other Changes

- A cache key that does not slide, sized against the two ADR 0019 knows ([15cce83](https://github.com/GMOD/bam-js/commit/15cce83c4c2d0f6b0667c3a5ac95f5cb3951bf3f))
- Move graphviz dataflow diagram into docs/img/ ([0e2dda5](https://github.com/GMOD/bam-js/commit/0e2dda5f26853f7a0be21ee12232f29d98f30edb))

### Styling

- Reflow CONTRIBUTING.md after the docs/img move ([5ba054b](https://github.com/GMOD/bam-js/commit/5ba054b5471f13ab6476958bdae2e9ebf7beb321))

## [8.9.0](https://github.com/GMOD/bam-js/compare/v8.8.1...v8.9.0) (2026-08-13)

### Performance Improvements

- Re-test the early stop as each chunk lands, not only after the first batch ([226dbbf](https://github.com/GMOD/bam-js/commit/226dbbf39fe3d727051dda9bac0a002fa3f3545e))

### Tests

- Pin the deep-query stop, with the fixture built rather than found ([e00e79a](https://github.com/GMOD/bam-js/commit/e00e79a3d93749e8f58852063f9d52fc6a8aa363))

## [8.8.1](https://github.com/GMOD/bam-js/compare/v8.8.0...v8.8.1) (2026-08-12)

### Other Changes

- @gmod/bgzf-filehandle 6.6.0, and say why holding a pool is safe ([dadefd4](https://github.com/GMOD/bam-js/commit/dadefd4716ddb7cd7c4a0c5ae7b4ef22f9d7a991))

## [8.8.0](https://github.com/GMOD/bam-js/compare/v8.7.0...v8.8.0) (2026-08-11)

### Features

- Export referenceNibble and CHAR_CODE_FROM_NIBBLE ([255a3dd](https://github.com/GMOD/bam-js/commit/255a3dd361798a3ccc11b13f965dfacc57460439))

## [8.7.0](https://github.com/GMOD/bam-js/compare/v8.6.0...v8.7.0) (2026-08-11)

### Chores

- Gitignore the local Claude settings and agent worktrees ([76e2337](https://github.com/GMOD/bam-js/commit/76e2337874afa044a86a95a81d9e2b659f033e53))

### Features

- An origin for mismatch positions, matching @gmod/cram ([618386b](https://github.com/GMOD/bam-js/commit/618386bb29e5e105687a7f29e3da6a70ccc8d776))

## [8.6.0](https://github.com/GMOD/bam-js/compare/v8.5.1...v8.6.0) (2026-08-11)

### Chores

- Enforce type strippability in tsconfig, align eslint rules ([bfa9904](https://github.com/GMOD/bam-js/commit/bfa9904fbe878ab661cd69197dfa521123c20e8e))

### Documentation

- Document mismatches, and wire the reference through htsget ([1b8b70c](https://github.com/GMOD/bam-js/commit/1b8b70c5943596a70ec33bf320270eafd903cc16))
- Measure the walk on the long-read fixtures, and price adoption ([e7c6ed0](https://github.com/GMOD/bam-js/commit/e7c6ed06b4a455d2c3603cd31535aa57109c5156))

### Features

- Report a read's mismatches, from MD or from a fetched reference ([427a83a](https://github.com/GMOD/bam-js/commit/427a83a96af4b6e7a3e1ca59a4033cee5143af22))

## [8.5.1](https://github.com/GMOD/bam-js/compare/v8.5.0...v8.5.1) (2026-08-11)

### Chores

- Render only the commit subject, and link the commit ([140fea7](https://github.com/GMOD/bam-js/commit/140fea787f80c02f88a1b01ffe419ac404ded402))

### Documentation

- Cut the README down, move the caching discussion out ([a1d27ef](https://github.com/GMOD/bam-js/commit/a1d27ef8e59aac2f5da2ce6b491bf4ecd1b4bc4d))
- Link the bgzf worker pool docs from the worker pool section ([0607d3b](https://github.com/GMOD/bam-js/commit/0607d3b4ca57b9e915a3722acf24fa64f776b0ad))
- Put the release note after the trusted-publishing setup ([6696141](https://github.com/GMOD/bam-js/commit/6696141d5f3c2347a33984cb3bad66d9b7e4dff9))
- Move the API reference to docs/api.md ([bc802b8](https://github.com/GMOD/bam-js/commit/bc802b8d04a76bedbec29b4fbd2c0b29b28ba2b5))

## [8.5.0](https://github.com/GMOD/bam-js/compare/v8.4.2...v8.5.0) (2026-08-11)

### Other Changes

- Optionally inflate chunks on a bgzf worker pool (#132) ([e7f9470](https://github.com/GMOD/bam-js/commit/e7f9470fc41729c2e7589f22ad10758f676d13b5))

## [8.4.2](https://github.com/GMOD/bam-js/compare/v8.4.1...v8.4.2) (2026-08-10)

## [8.4.1](https://github.com/GMOD/bam-js/compare/v8.4.0...v8.4.1) (2026-08-10)

### Chores

- Gate preversion on format:check, as CI does
- Gate preversion on typecheck too, as CI does
- Converge package.json on the shape its siblings use

### Other Changes

- Revert "chore: converge package.json" — the CHANGELOG prettier step ([ea726f0](https://github.com/GMOD/bam-js/commit/ea726f0731b0b289750125570f8468979634172e))

## [8.4.0](https://github.com/GMOD/bam-js/compare/v8.3.1...v8.4.0) (2026-08-10)

### Chores

- Require @gmod/shared-read-cache 1.5.0 for cacheBudget

### Documentation

- Two claims about the idle sweep that were not true

### Features

- CacheBudget, so several files can share one ceiling

## [8.3.1](https://github.com/GMOD/bam-js/compare/v8.3.0...v8.3.1) (2026-08-09)

### Bug Fixes

- Estimate the bytes a query reads, not the chunks it could need
- Bump @gmod/shared-read-cache to 1.4.4

### Documentation

- ADR 0016 — the cache does not grow, and LRU stays
- Two comments that stopped being true

### Refactoring

- The header and index parses are shared reads, not memos

## [8.3.0](https://github.com/GMOD/bam-js/compare/v8.2.0...v8.3.0) (2026-08-06)

### Bug Fixes

- HtsgetFile forwards the cache options to BamFile

## [8.2.0](https://github.com/GMOD/bam-js/compare/v8.1.0...v8.2.0) (2026-08-06)

### Performance Improvements

- Reclaim the chunk cache when nothing is using it

## [8.1.0](https://github.com/GMOD/bam-js/compare/v8.0.0...v8.1.0) (2026-08-06)

### Performance Improvements

- Size the chunk cache to hold several queries, not one

## [8.0.0](https://github.com/GMOD/bam-js/compare/v7.9.1...v8.0.0) (2026-08-06)

### Bug Fixes

- A bystander no longer inherits the getHeader owner's abort

### Chores

- Let npm publish stop auto-correcting repository.url
- Exempt our own packages from the release quarantine
- Bump pnpm/action-setup to v6.0.10
- Run the test suite as `pnpm test --run`

### Documentation

- ADR 0013 — the chunk cache stays on the lru eviction policy

### Refactoring

- Align the shared-read abort plumbing with @gmod/tabix
- **BREAKING** Use @gmod/shared-read-cache for the chunk cache

### Tests

- Wait on the parked header read instead of a tick
- Size the suite timeout to the work the tests do

## [7.9.1](https://github.com/GMOD/bam-js/compare/v7.9.0...v7.9.1) (2026-08-05)

### Bug Fixes

- Cancel a shared chunk read only once every waiter has aborted
- Do not let an already-aborted caller pin a shared chunk read
- Guard the already-aborted case in joinChunkRead as well
- A bystander no longer inherits the .bai parse owner's abort

### Chores

- Drop eslint-plugin-unicorn

### Documentation

- Re-check the `name` decode on real records, not synthetic buffers

### Performance Improvements

- Do not inflate or decode a chunk every caller has abandoned

### Styling

- Prettier, and correct two stale notes

## [7.9.0](https://github.com/GMOD/bam-js/compare/v7.8.2...v7.9.0) (2026-08-05)

### Bug Fixes

- Keep the CIGAR an unmapped record stores
- Stop losing records and throwing on legitimate queries

### Chores

- Type-check the tests too, and fix what that turned up

### Documentation

- Say why the CSI aux parse is dead code here
- Which cram-js decode optimizations transfer, and what the corpus said

### Features

- GetTagAlt resolves an alias pair in one pass over the tag block

### Performance Improvements

- Decode seq four bases at a time, build CIGAR without the throwaway

### Refactoring

- **BREAKING** Drop the Bytes type, which describes nothing

### Styling

- Format the tree with prettier and enforce it in CI

### Tests

- Compare every field samtools prints, not just read identity
- Let the alignment comparison read a file linearly
- Cover the index and htsget edge paths coverage found

## [7.8.2](https://github.com/GMOD/bam-js/compare/v7.8.1...v7.8.2) (2026-08-05)

### Bug Fixes

- Drop reads that end exactly where the query starts

### Chores

- Install samtools so the agreement suite actually runs

### Documentation

- Record why chunk merging stays, and why its gap is 65000
- ADR 0011 on keeping chunk merging behind a range cache
- Note that the P CIGAR op is not worth more test investment

### Tests

- Pin the CSI path against BAI, reads included
- Check every indexed BAM against samtools, and fix the P CIGAR op
- Walk only references that hold records, and share one file scan
- Keep the samtools comparison off the network
- Fail in CI when samtools is missing

## [7.8.1](https://github.com/GMOD/bam-js/compare/v7.8.0...v7.8.1) (2026-08-04)

### Bug Fixes

- Stop returning records twice when a query's chunks overlap

## [7.8.0](https://github.com/GMOD/bam-js/compare/v7.7.1...v7.8.0) (2026-08-04)

### Documentation

- Benchmark waves vs pool for ADR 0010

### Performance Improvements

- Stop reading a query's chunks once one lies past its range

### Tests

- Pin the shared empty linear index, and record the early-stop finding

## [7.7.1](https://github.com/GMOD/bam-js/compare/v7.7.0...v7.7.1) (2026-08-04)

### Bug Fixes

- Stop the packed linear index regressing many-scaffold assemblies

## [7.7.0](https://github.com/GMOD/bam-js/compare/v7.6.2...v7.7.0) (2026-08-04)

### Bug Fixes

- Keep colon-less SAM header fields (@CO) intact when parsing
- Bound the mate-chunk fan-out and dedupe it on the cache key

### Performance Improvements

- Pack the BAI linear index into typed arrays

## [7.6.2](https://github.com/GMOD/bam-js/compare/v7.6.1...v7.6.2) (2026-08-01)

### Bug Fixes

- Stop reading the whole BAM when the header read comes up short

### Chores

- Replace standard-changelog with git-cliff for changelog generation

### Documentation

- Correct and condense README
- Backfill CHANGELOG entries left empty since standard-changelog only picks up feat/fix/perf commits
- Mark breaking changes in the generated changelog

### Features

- Add a fetch option to HtsgetFile, and fix htsget-rs compatibility (#128)

## [7.6.1](https://github.com/GMOD/bam-js/compare/v7.6.0...v7.6.1) (2026-07-31)


### Performance Improvements

* find firstDataLine without allocating a VirtualOffset per index entry ([cd59ffc](https://github.com/GMOD/bam-js/commit/cd59ffc0305a9648f152427eaf7650418bf41b01))

# [7.6.0](https://github.com/GMOD/bam-js/compare/v7.5.0...v7.6.0) (2026-07-31)


### Performance Improvements

* fetch a query's chunks concurrently ([1c80139](https://github.com/GMOD/bam-js/commit/1c80139b4042860c295b691c7f60061e22988fce))
* pass BamRecord constructor args positionally ([dbd5491](https://github.com/GMOD/bam-js/commit/dbd5491e347d9ed4f320ae9aecc9f995092ff36b))
* share in-flight chunk reads between concurrent queries ([b4a7bf9](https://github.com/GMOD/bam-js/commit/b4a7bf9f122259f7d0e943402032d46cba2ffd86))
* skip the worker pool for single-chunk queries ([69f5cfd](https://github.com/GMOD/bam-js/commit/69f5cfd12b24768aca55cb2084229500fcef3bcd))

# [7.5.0](https://github.com/GMOD/bam-js/compare/v7.4.0...v7.5.0) (2026-07-25)


### Performance Improvements

* intern tag names and decode short Z/H tag values without TextDecoder ([420b491](https://github.com/GMOD/bam-js/commit/420b49126421df9bb9ced8dc4657b3f44ef3bb7a))
* keep every chunk a query parses cached, and filter in the caller ([bde84b1](https://github.com/GMOD/bam-js/commit/bde84b162d98b8372e2569cec97794208dbfd56f))


### BREAKING CHANGES

* BamOpts.filterBy is removed, along with the FilterBy and
TagFilter types and the applyFilters/filterReadFlag/filterTagValue
helpers. Apply filters to the records getRecordsForRange returns.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

# [7.4.0](https://github.com/GMOD/bam-js/compare/v7.3.4...v7.4.0) (2026-07-25)


### Bug Fixes

* **record:** derive pair_orientation from mate position, not template_length ([59714fc](https://github.com/GMOD/bam-js/commit/59714fc2accf55feaf687e550bfb617c494162e1))


### Performance Improvements

* bound the parsed-chunk cache by decompressed bytes ([8e6aa19](https://github.com/GMOD/bam-js/commit/8e6aa1968c7acdd6845cbd2c61d90e1c18ea0768))
* key chunk cache on byte span only, apply filters on retrieval ([57b0fdd](https://github.com/GMOD/bam-js/commit/57b0fdd5173416919af6d65d11f6ae742c668d94))

## [7.3.4](https://github.com/GMOD/bam-js/compare/v7.3.3...v7.3.4) (2026-07-01)

- Dedupe BAM tag-value parsing between the full-tags path and single-tag lookups, dropping now-unused code

## [7.3.3](https://github.com/GMOD/bam-js/compare/v7.3.2...v7.3.3) (2026-06-25)


### Features

* tighten index byte-size estimate by clamping chunk ends to next block boundary ([49f51b4](https://github.com/GMOD/bam-js/commit/49f51b4bcb7a5cabcf8790a7eb13e22bc7ad3c6a))

## [7.3.2](https://github.com/GMOD/bam-js/compare/v7.3.1...v7.3.2) (2026-06-19)


### Features

* report .bai/.csi index download progress via onProgress ([bdf9176](https://github.com/GMOD/bam-js/commit/bdf917681184487111476077481b5e51390234c8))

## [7.3.1](https://github.com/GMOD/bam-js/compare/v7.3.0...v7.3.1) (2026-06-19)


### Bug Fixes

* don't forward onProgress to inner read in _readChunkFeatures ([8df2476](https://github.com/GMOD/bam-js/commit/8df2476dac9c457d74ecf30ab2a387f818b1c26a))

# [7.3.0](https://github.com/GMOD/bam-js/compare/v7.2.4...v7.3.0) (2026-06-18)


### Bug Fixes

* qual for unmapped reads, flags sign-extension, CG-tag guard; dedup tag parser ([909b160](https://github.com/GMOD/bam-js/commit/909b160385a23b200372dc0e7c6d4f9e208999ac))
* remove stale workflow query link from CI badge ([e38d9a7](https://github.com/GMOD/bam-js/commit/e38d9a74bcbb0301833d1846a1e3b2f3f092ba77))
* update CI badge to reference publish.yml workflow ([f2434df](https://github.com/GMOD/bam-js/commit/f2434dff1d1d4f85d5cf9ae14f420067d1bb1249))


### Features

* report download progress from getRecordsForRange via onProgress ([a23d634](https://github.com/GMOD/bam-js/commit/a23d634edfbaf90fc697e6d2dd6a1c7e8f03c30c))

## [7.2.4](https://github.com/GMOD/bam-js/compare/v7.2.3...v7.2.4) (2026-05-19)

- Broaden `BamRecord.toJSON`'s return type to `Record<string, unknown>` so subclasses can override it with their own serialized shape

## [7.2.3](https://github.com/GMOD/bam-js/compare/v7.2.2...v7.2.3) (2026-05-19)

- No functional change (CI workflow rename to restore npm OIDC trusted-publish trust)

## [7.2.2](https://github.com/GMOD/bam-js/compare/v7.2.1...v7.2.2) (2026-05-19)

- No functional change (CI workflow reorganization: merged publish into push workflow)

## [7.2.1](https://github.com/GMOD/bam-js/compare/v7.2.0...v7.2.1) (2026-05-19)

- Fix unbounded loop in `_readChunkFeatures` missing a bounds check against `dpositions.length`
- Memoize `HtsgetFile.getHeader` instead of re-fetching and re-parsing the header on every call

# [7.2.0](https://github.com/GMOD/bam-js/compare/v7.1.21...v7.2.0) (2026-05-18)

- Fix CSI `reg2bins` off-by-one/clamp bug that could miss or mis-scope overlapping bins for CSI-indexed queries
- Fix `BamRecord.toJSON`, which previously serialized almost nothing since `Object.keys()` can't see prototype getters
- Fix `optimizeChunks` mutating `Chunk` objects shared with the index's per-refId cache
- Refactor shared `blocksForRange`/parse/lineCount logic into a common `IndexFile` base class

## [7.1.21](https://github.com/GMOD/bam-js/compare/v7.1.20...v7.1.21) (2026-04-27)

- Share a single `DataView` across `BamRecord` fields and drop redundant field caching; decode string tags via `TextDecoder` instead of per-char concatenation
- Split CIGAR/length-on-ref computation into separate cached getters for clarity and speed

## [7.1.20](https://github.com/GMOD/bam-js/compare/v7.1.19...v7.1.20) (2026-03-28)

- No functional change (tooling migration: pnpm, TypeScript 6, ESM syntax, Node 24 publish workflow)

## [7.1.19](https://github.com/GMOD/bam-js/compare/v7.1.18...v7.1.19) (2026-03-04)

- Fix header parsing for BAM files with large reference-sequence tables: retry with a doubled read length instead of throwing when the initial buffer is too short

## [7.1.18](https://github.com/GMOD/bam-js/compare/v7.1.17...v7.1.18) (2026-03-04)

- Fix `estimatedBytesForRegions` to return zero, instead of mis-estimating, for unknown reference sequences

## [7.1.17](https://github.com/GMOD/bam-js/compare/v7.1.16...v7.1.17) (2026-02-14)

- Further optimize `pair_orientation` using a precomputed lookup table indexed by flag bits and insert-size sign

## [7.1.16](https://github.com/GMOD/bam-js/compare/v7.1.15...v7.1.16) (2026-02-14)

- Optimize `pair_orientation` by inlining flag bit checks instead of calling flag helper methods

## [7.1.15](https://github.com/GMOD/bam-js/compare/v7.1.14...v7.1.15) (2025-12-17)

- No functional change (dependency patch bump and import reordering only)

## [7.1.14](https://github.com/GMOD/bam-js/compare/v7.1.13...v7.1.14) (2025-12-17)

- Switch from `quick-lru` to `@jbrowse/quick-lru` for CommonJS compatibility

## [7.1.13](https://github.com/GMOD/bam-js/compare/v7.1.12...v7.1.13) (2025-12-17)

- Faster CIGAR reference-length calculation using a bitmask lookup instead of a per-op branch

## [7.1.12](https://github.com/GMOD/bam-js/compare/v7.1.11...v7.1.12) (2025-12-17)

- Add `getTag(name)`/`getTagRaw(name)` methods for looking up a single tag without parsing/caching the full tags object

## [7.1.11](https://github.com/GMOD/bam-js/compare/v7.1.10...v7.1.11) (2025-12-16)

- Add `filterBy` option (flagInclude/flagExclude/tagFilter) to `getRecordsForRange` to skip caching features that don't match
- Remove the `streamRecordsForRange` async generator API in favor of building results directly

## [7.1.10](https://github.com/GMOD/bam-js/compare/v7.1.9...v7.1.10) (2025-12-15)

- Cache `ref_id`/`start`/`end` field reads on `BamRecord` to avoid repeated `DataView` lookups
- Parse CIGAR into a `Uint32Array` when byte-aligned and large, plain array otherwise, based on benchmarking

## [7.1.9](https://github.com/GMOD/bam-js/compare/v7.1.8...v7.1.9) (2025-12-13)

- Allow `HtsgetFile` to accept a custom `recordClass`, matching `BamFile`

## [7.1.8](https://github.com/GMOD/bam-js/compare/v7.1.7...v7.1.8) (2025-12-13)

- Remove the `id` getter from `BamRecordLike`/`BamRecord`; internal pairing logic now uses `fileOffset` directly

## [7.1.7](https://github.com/GMOD/bam-js/compare/v7.1.6...v7.1.7) (2025-12-13)

- Change `BamRecord.id` from a numeric `fileOffset` to a stringified one, for use as a stable object/map key

## [7.1.6](https://github.com/GMOD/bam-js/compare/v7.1.5...v7.1.6) (2025-12-13)

- Add support for a custom `BamRecord` class: `BamFile` is now generic and accepts a `recordClass` constructor option

## [7.1.5](https://github.com/GMOD/bam-js/compare/v7.1.4...v7.1.5) (2025-12-13)

- Replace decorator-based getter caching with explicit per-instance cached fields for `flags`, `tags`, CIGAR, and `NUMERIC_MD`
- Avoid an unnecessary array copy in `NUMERIC_SEQ`

## [7.1.4](https://github.com/GMOD/bam-js/compare/v7.1.3...v7.1.4) (2025-12-13)

- Cache the `NUMERIC_MD` getter result per record
- Compare raw byte codes instead of `String.fromCharCode` strings when scanning for the MD tag

## [7.1.3](https://github.com/GMOD/bam-js/compare/v7.1.2...v7.1.3) (2025-12-12)

- Add `NUMERIC_MD` getter that reads the raw MD tag bytes directly without parsing the full tags object

## [7.1.2](https://github.com/GMOD/bam-js/compare/v7.1.1...v7.1.2) (2025-12-12)

- Add `estimatedBytesForRegions` to estimate bytes that would be fetched for a set of regions
- Optimize `optimizeChunks` and BAI/CSI `blocksForRange` chunk lookups

## [7.1.1](https://github.com/GMOD/bam-js/compare/v7.1.0...v7.1.1) (2025-12-12)

- Re-add chunk-based feature caching to `BamFile`, with overlapping cached chunks evicted on overlap
- Add `clearFeatureCache()`

# [7.1.0](https://github.com/GMOD/bam-js/compare/v7.0.6...v7.1.0) (2025-12-11)

- Convert to the WASM-based `@gmod/bgzf-filehandle`

## [7.0.6](https://github.com/GMOD/bam-js/compare/v7.0.5...v7.0.6) (2025-11-28)

- Remove a buggy chrId/min/max pre-filter in chunk feature parsing that could mis-filter or drop records

## [7.0.5](https://github.com/GMOD/bam-js/compare/v7.0.4...v7.0.5) (2025-11-27)

- Micro-optimize the CIGAR-consumes-reference check using bitwise shifts and a bitmask

## [7.0.4](https://github.com/GMOD/bam-js/compare/v7.0.3...v7.0.4) (2025-11-24)

- No functional change (patch bump of `@gmod/bgzf-filehandle`)

## [7.0.3](https://github.com/GMOD/bam-js/compare/v7.0.2...v7.0.3) (2025-11-24)

- No functional change (patch bump of `@gmod/bgzf-filehandle`)

## [7.0.2](https://github.com/GMOD/bam-js/compare/v7.0.1...v7.0.2) (2025-11-24)

- Return typed-array views directly over the record buffer for BAM tag arrays and CIGAR instead of copying, falling back to slice only when unaligned

## [7.0.1](https://github.com/GMOD/bam-js/compare/v7.0.0...v7.0.1) (2025-11-24)

- Added NUMERIC_SEQ to get the raw encoded seq array

# [7.0.0](https://github.com/GMOD/bam-js/compare/v6.1.1...v7.0.0) (2025-11-24)

- Introduced the idea of returning TypedArrays for different tag types

## [6.1.1](https://github.com/GMOD/bam-js/compare/v6.1.0...v6.1.1) (2025-10-02)

- Add `seqAt(idx)` to `BamRecord` for decoding a single base by index without building the full sequence string

# [6.1.0](https://github.com/GMOD/bam-js/compare/v6.0.4...v6.1.0) (2025-10-01)

- Add an LRU cache for decompressed BGZF blocks so repeated reads of the same block avoid re-inflating it

## [6.0.4](https://github.com/GMOD/bam-js/compare/v6.0.3...v6.0.4) (2025-05-26)

- No functional change (dependency bump of `@gmod/bgzf-filehandle`)

## [6.0.3](https://github.com/GMOD/bam-js/compare/v6.0.2...v6.0.3) (2025-05-13)

- No functional change (build script tweak only)

## [6.0.2](https://github.com/GMOD/bam-js/compare/v6.0.1...v6.0.2) (2025-04-30)

- No functional change (dependency patch bump)

## [6.0.1](https://github.com/GMOD/bam-js/compare/v6.0.0...v6.0.1) (2025-04-30)

- No functional change (dependency bump of `@gmod/bgzf-filehandle`)

# [6.0.0](https://github.com/GMOD/bam-js/compare/v5.0.7...v6.0.0) (2025-04-30)

- Switch to a pure ESM build alongside the CJS build
- Remove the `AbortablePromiseCache`-based per-chunk feature cache, decoding chunks directly instead

## [5.0.7](https://github.com/GMOD/bam-js/compare/v5.0.6...v5.0.7) (2025-03-11)

- Fix CSI index regression from the v5.0.6 lazy-loading refactor: the header-end-offset scan no longer collected virtual offsets from chunks

## [5.0.6](https://github.com/GMOD/bam-js/compare/v5.0.5...v5.0.6) (2025-02-28)

- Lazily parse per-chromosome index data in BAI/CSI instead of eagerly parsing the whole index up front, with an LRU cache of parsed entries

## [5.0.5](https://github.com/GMOD/bam-js/compare/v5.0.4...v5.0.5) (2024-12-18)

- Drop the `longfn` dependency, replacing it with a small inline 64-bit-from-bytes helper

## [5.0.4](https://github.com/GMOD/bam-js/compare/v5.0.2...v5.0.4) (2024-12-18)

- Replace `long.js` with the smaller `longfn` library for parsing 64-bit pseudo-bin line counts

## [5.0.3](https://github.com/GMOD/bam-js/compare/v5.0.2...v5.0.3) (2024-12-18)

- No corresponding git tag exists for this version; its changes, if any, are folded into v5.0.4 above

## [5.0.2](https://github.com/GMOD/bam-js/compare/v5.0.1...v5.0.2) (2024-12-17)

- No functional change (crc32 import fix to avoid pulling in a Buffer polyfill)

## [5.0.1](https://github.com/GMOD/bam-js/compare/v5.0.0...v5.0.1) (2024-12-12)

- Fix htsget data-URL decoding: replace non-standard `Uint8Array.fromBase64` with a `fetch()`-based base64 decode

# [5.0.0](https://github.com/GMOD/bam-js/compare/v4.0.1...v5.0.0) (2024-12-12)

- Migrate from Node `Buffer`/`generic-filehandle` to `generic-filehandle2`, `Uint8Array`, `DataView`, and `TextDecoder` throughout, for browser compatibility
- Bump `@gmod/bgzf-filehandle`

## [4.0.1](https://github.com/GMOD/bam-js/compare/v4.0.0...v4.0.1) (2024-11-12)

- Fix `pair_orientation` tag: now returns `undefined` instead of an empty string when a record is not part of a pair

# [4.0.0](https://github.com/GMOD/bam-js/compare/v3.0.3...v4.0.0) (2024-11-12)

- Build tag/attribute value getters (`qual`, `Z`/`H`/`B` array tags, CG tag) via arrays and `.join()` instead of string concatenation; drop the redundant `qualRaw` getter in favor of `qual`

## [3.0.3](https://github.com/GMOD/bam-js/compare/v3.0.0...v3.0.3) (2024-11-11)

- Fix BAI chunk objects being pushed as shared references into results instead of fresh `Chunk` instances, causing incorrect coverage rendering; re-applies the v3.0.1 fix that v3.0.2 had dropped

## [3.0.2](https://github.com/GMOD/bam-js/compare/v3.0.0...v3.0.2) (2024-11-11)

- republish v3.0.1 since it got tagged on a deleted branch
- Despite the name, this republish matches v3.0.0's code exactly and does not include the v3.0.1 fix below (that fix lands again in v3.0.3)

## [3.0.1](https://github.com/GMOD/bam-js/compare/v3.0.0...v3.0.1) (2024-11-11)

- Fix BAI `blocksForRange` pushing shared bin-chunk objects into results instead of fresh `Chunk` instances, avoiding downstream mutation bugs

# [3.0.0](https://github.com/GMOD/bam-js/compare/v2.0.4...v3.0.0) (2024-11-07)

- Refactor `BamRecord` from a lazy-caching `get(field)` model to plain computed getters reading directly off the byte buffer
- Drop the `long` package dependency, using native `BigInt64` reads instead

## [2.0.4](https://github.com/GMOD/bam-js/compare/v2.0.3...v2.0.4) (2024-08-09)

- Switch from `buffer-crc32` to `crc` for crc32 calculation

## [2.0.3](https://github.com/GMOD/bam-js/compare/v2.0.2...v2.0.3) (2024-07-23)

### Reverts

- Revert "Migrate to eslint9"
  ([65adcbb](https://github.com/GMOD/bam-js/commit/65adcbb2793243659682d30694f8604d241a5337))
- Revert "Run format"
  ([2a02535](https://github.com/GMOD/bam-js/commit/2a02535db4df80f245232522cdba771cbf5ea214))

## [2.0.2](https://github.com/GMOD/bam-js/compare/v2.0.1...v2.0.2) (2024-02-21)

- Update typescript-eslint config and related fixes

## [2.0.1](https://github.com/GMOD/bam-js/compare/v2.0.0...v2.0.1) (2024-2-20)

- Update to buffer-crc32 1.0.0
- Fix BAM header parsing of refNames containing a :

# [2.0.0](https://github.com/GMOD/bam-js/compare/v1.1.18...v2.0.0) (2023-06-08)

### Features

- explicit buffer import ([#98](https://github.com/GMOD/bam-js/issues/98))
  ([66de9f4](https://github.com/GMOD/bam-js/commit/66de9f4ce30e3ff647d5297f093695e92ec9227c))

* Add explicit buffer import
* Remove cross-fetch and object.entries polyfills
* Improve typescripting
* Remove chunkSizeLimit and fetchSizeLimit

## [1.1.18](https://github.com/GMOD/bam-js/compare/v1.1.17...v1.1.18) (2022-12-17)

- Use es2015 for nodejs build

## [1.1.17](https://github.com/GMOD/bam-js/compare/v1.1.16...v1.1.17) (2022-07-18)

- Bump devDeps and generic-filehandle to 3.0.0

## [1.1.16](https://github.com/GMOD/bam-js/compare/v1.1.15...v1.1.16) (2022-03-30)

- Add src directory for better source maps

## [1.1.15](https://github.com/GMOD/bam-js/compare/v1.1.14...v1.1.15) (2022-03-18)

- Fix for htsget failing with message 'input must be buffer, number, or string,
  received object'
- Speed improvement by caching chunks of features

## [1.1.14](https://github.com/GMOD/bam-js/compare/v1.1.13...v1.1.14) (2022-03-14)

- Fix seq function for corner case

## [1.1.13](https://github.com/GMOD/bam-js/compare/v1.1.12...v1.1.13) (2022-02-25)

- Optimize qual and sequence string record functions for less GC pressure

<a name="1.1.12"></a>

## [1.1.12](https://github.com/GMOD/bam-js/compare/v1.1.11...v1.1.12) (2022-02-17)

- Add blocksForRange method to BamFile class to help stats estimation in JBrowse
  2

<a name="1.1.11"></a>

## [1.1.11](https://github.com/GMOD/bam-js/compare/v1.1.10...v1.1.11) (2022-01-26)

- Cache setup of index file parsing

<a name="1.1.10"></a>

## [1.1.10](https://github.com/GMOD/bam-js/compare/v1.1.9...v1.1.10) (2022-01-18)

- Make \_refID and flags public fields
- Small internal changes to the handling of opts

<a name="1.1.9"></a>

## [1.1.9](https://github.com/GMOD/bam-js/compare/v1.1.8...v1.1.9) (2021-12-14)

- Add ESM module export in package.json (smaller bundle size for consumers)
- Cache BAI readFile result for compatibility with node.js native filehandles
  (which otherwise fail if re-reading the filehandle twice)

<a name="1.1.8"></a>

## [1.1.8](https://github.com/GMOD/bam-js/compare/v1.1.7...v1.1.8) (2021-05-21)

- Fix types for yieldThreadTime

<a name="1.1.7"></a>

## [1.1.7](https://github.com/GMOD/bam-js/compare/v1.1.6...v1.1.7) (2021-05-21)

- New param yieldThreadTime to constructor to yield while processing

<a name="1.1.6"></a>

## [1.1.6](https://github.com/GMOD/bam-js/compare/v1.1.5...v1.1.6) (2021-02-20)

- Add qualRaw function on records for getting raw qual score array instead of
  string

<a name="1.1.5"></a>

## [1.1.5](https://github.com/GMOD/bam-js/compare/v1.1.4...v1.1.5) (2020-12-11)

- Allow getHeaderText to accept cancellation options

<a name="1.1.4"></a>

## [1.1.4](https://github.com/GMOD/bam-js/compare/v1.1.3...v1.1.4) (2020-12-11)

- Add canMergeBlocks to CSI code (already existed in BAI)
- Add suggestion from @jrobinso about reg2bins modification for memory saving
  (Thanks!)
- Add getHeaderText() method for getting a text string of the header data

<a name="1.1.3"></a>

## [1.1.3](https://github.com/GMOD/bam-js/compare/v1.1.2...v1.1.3) (2020-10-29)

- Fix usage of feature.get('seq'), was using feature.getReadBases before this

<a name="1.1.2"></a>

## [1.1.2](https://github.com/GMOD/bam-js/compare/v1.1.1...v1.1.2) (2020-10-02)

- Fix signedness in BAM tags (#65)
- Remove unused seq_reverse_complemented tag from \_tags()

<a name="1.1.1"></a>

## [1.1.1](https://github.com/GMOD/bam-js/compare/v1.1.0...v1.1.1) (2020-09-20)

- Remove JBrowse specific results from tags

<a name="1.1.0"></a>

# [1.1.0](https://github.com/GMOD/bam-js/compare/v1.0.42...v1.1.0) (2020-08-28)

- Add support for the CG tag for long CIGAR strings

<a name="1.0.42"></a>

## [1.0.42](https://github.com/GMOD/bam-js/compare/v1.0.41...v1.0.42) (2020-08-19)

- Small bugfix for Htsget specifically

<a name="1.0.41"></a>

## [1.0.41](https://github.com/GMOD/bam-js/compare/v1.0.40...v1.0.41) (2020-08-19)

- Add htsget example
- Support opts object to getHeader allowing things like auth headers to be
  passed right off the bat

<a name="1.0.40"></a>

## [1.0.40](https://github.com/GMOD/bam-js/compare/v1.0.39...v1.0.40) (2020-07-30)

<a name="1.0.39"></a>

## [1.0.39](https://github.com/GMOD/bam-js/compare/v1.0.38...v1.0.39) (2020-07-30)

- Don't use origin master in the follow-tags postpublish command for cleaner
  version publishing

<a name="1.0.38"></a>

## [1.0.38](https://github.com/GMOD/bam-js/compare/v1.0.37...v1.0.38) (2020-07-30)

- Direct construction of qual/seq toString
- Improve performance of the uniqueID calculation for pathological cases where
  there are tons of bins

<a name="1.0.37"></a>

## [1.0.37](https://github.com/GMOD/bam-js/compare/v1.0.36...v1.0.37) (2020-06-06)

- Typescript only release: export BamRecord types

<a name="1.0.36"></a>

## [1.0.36](https://github.com/GMOD/bam-js/compare/v1.0.35...v1.0.36) (2020-03-05)

- Adds a shortcut to stop parsing chunks after a record is detected to be
  outside the requested range while decoding

<a name="1.0.35"></a>

## [1.0.35](https://github.com/GMOD/bam-js/compare/v1.0.34...v1.0.35) (2020-02-04)

- Update scheme used to calculate unique fileOffset based IDs using
  @gmod/bgzf-filehandle updates

<a name="1.0.34"></a>

## [1.0.34](https://github.com/GMOD/bam-js/compare/v1.0.33...v1.0.34) (2020-01-24)

- Small fix for using id() instead of .get('id') for weird SAM records
  containing ID field

<a name="1.0.33"></a>

## [1.0.33](https://github.com/GMOD/bam-js/compare/v1.0.32...v1.0.33) (2020-01-24)

- Perform decoding of entire chunk up front to aid caching, reverts change in
  1.0.29

<a name="1.0.32"></a>

## [1.0.32](https://github.com/GMOD/bam-js/compare/v1.0.31...v1.0.32) (2019-11-16)

- Add a speed improvement for long reads by pre-allocating sequence/quality
  scores array

<a name="1.0.31"></a>

## [1.0.31](https://github.com/GMOD/bam-js/compare/v1.0.30...v1.0.31) (2019-11-07)

- Fix example of the "ID" field failing to return the right data

<a name="1.0.30"></a>

## [1.0.30](https://github.com/GMOD/bam-js/compare/v1.0.29...v1.0.30) (2019-11-07)

- Add fix that was causing the parser to not return all tags from the \_tags API

<a name="1.0.29"></a>

## [1.0.29](https://github.com/GMOD/bam-js/compare/v1.0.28...v1.0.29) (2019-10-31)

- Decoding of the BAM records at time of use instead of entire chunk decoded up
  front
- Alternate chunk merging strategy inspired by igv.js code

<a name="1.0.28"></a>

## [1.0.28](https://github.com/GMOD/bam-js/compare/v1.0.27...v1.0.28) (2019-10-29)

- Add CSI index block merging
- Change unique ID generator to be smaller numeric IDs

<a name="1.0.27"></a>

## [1.0.27](https://github.com/GMOD/bam-js/compare/v1.0.26...v1.0.27) (2019-10-10)

- Make feature IDs become generated based relative to the exact bgzip block

<a name="1.0.26"></a>

## [1.0.26](https://github.com/GMOD/bam-js/compare/v1.0.25...v1.0.26) (2019-10-01)

- Restore issue with getRecordsForRange not returning all features (#44)
- Fix compatibility with electron (#43)
- Fix usage of feature.get('seq')

<a name="1.0.25"></a>

## [1.0.25](https://github.com/GMOD/bam-js/compare/v1.0.24...v1.0.25) (2019-09-29)

- Fixed some typescript typings

<a name="1.0.24"></a>

## [1.0.24](https://github.com/GMOD/bam-js/compare/v1.0.22...v1.0.24) (2019-09-27)

- Added typescript typings

<a name="1.0.23"></a>

## [1.0.22](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.22) (2019-09-27)

- Added typescript typings
- Botched release, was removed from npm

<a name="1.0.22"></a>

## [1.0.22](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.22) (2019-09-03)

- Fixed issue with features having different IDs across different chunks (#36)

<a name="1.0.21"></a>

## [1.0.21](https://github.com/GMOD/bam-js/compare/v1.0.20...v1.0.21) (2019-08-06)

- Add a fix for the small chunk unpacking re-seeking in the same bgzf block
  repeatedly (#35)

<a name="1.0.20"></a>

## [1.0.20](https://github.com/GMOD/bam-js/compare/v1.0.19...v1.0.20) (2019-06-06)

- Added a method for smaller chunk unpacking, by modifying the header parsing to
  return smaller chunks and the bgzf unzipping to respect chunk boundaries (#30)
- Use fileOffset as bam feature ID which previously was crc32 of the BAM buffer
  which consequently speeds up processing and allows exact duplicate features

## [1.0.19](https://github.com/GMOD/bam-js/compare/v1.0.18...v1.0.19) (2019-05-30)

- Added lineCount and hasRefSeq functions to BamFile, each accepting a string
  seqName
- Fixed aborting on index retrieval code

## [1.0.18](https://github.com/GMOD/bam-js/compare/v1.0.17...v1.0.18) (2019-05-01)

- Bump generic-filehandle to 1.0.9 to fix error with using native fetch (global
  fetch needed to be bound)
- Bump abortable-promise-cache to 1.0.1 version to fix error with using native
  fetch and abort signals

## [1.0.17](https://github.com/GMOD/bam-js/compare/v1.0.16...v1.0.17) (2019-04-28)

- Fix wrong number of arguments being passed to the readRefSeqs file read()
  invocation resulting in bad range requests

## [1.0.16](https://github.com/GMOD/bam-js/compare/v1.0.15...v1.0.16) (2019-04-28)

- Added indexCov algorithm to retrieve approximate coverage of the BAM inferred
  from the size of the BAI linear index bins
- Fixed abortSignal on read() calls
- Updated API to allow bamUrl/baiUrl/csiUrl

## [1.0.15](https://github.com/GMOD/bam-js/compare/v1.0.14...v1.0.15) (2019-04-04)

- Added check for too large of chromosomes in the bai bins
- Added aborting support (thanks @rbuels)
- Refactored index file class

<a name="1.0.14"></a>

## [1.0.14](https://github.com/GMOD/bam-js/compare/v1.0.13...v1.0.14) (2019-01-04)

- Add hasRefSeq for CSI indexes

<a name="1.0.13"></a>

## [1.0.13](https://github.com/GMOD/bam-js/compare/v1.0.12...v1.0.13) (2018-12-25)

- Use ascii decoding for read names
- Fix error with large BAM headers with many refseqs

<a name="1.0.12"></a>

## [1.0.12](https://github.com/GMOD/bam-js/compare/v1.0.11...v1.0.12) (2018-11-25)

- Faster viewAsPairs operation

<a name="1.0.11"></a>

## [1.0.11](https://github.com/GMOD/bam-js/compare/v1.0.10...v1.0.11) (2018-11-23)

- Fix for ie11

<a name="1.0.10"></a>

## [1.0.10](https://github.com/GMOD/bam-js/compare/v1.0.9...v1.0.10) (2018-11-18)

- Add a maxInsertSize parameter to getRecordsForRange

<a name="1.0.9"></a>

## [1.0.9](https://github.com/GMOD/bam-js/compare/v1.0.8...v1.0.9) (2018-11-16)

- Allow bases other than ACGT to be decoded
- Make viewAsPairs only resolve pairs on given refSeq unless pairAcrossChr is
  enabled for query

<a name="1.0.8"></a>

## [1.0.8](https://github.com/GMOD/bam-js/compare/v1.0.7...v1.0.8) (2018-10-31)

- Add getPairOrientation for reads

<a name="1.0.7"></a>

## [1.0.7](https://github.com/GMOD/bam-js/compare/v1.0.6...v1.0.7) (2018-10-19)

- Re-release of 1.0.6 due to build machinery error

<a name="1.0.6"></a>

## [1.0.6](https://github.com/GMOD/bam-js/compare/v1.0.5...v1.0.6) (2018-10-19)

- Add bugfix for where bytes for an invalid request returns 0 resulting in pako
  unzip errors

<a name="1.0.5"></a>

## [1.0.5](https://github.com/GMOD/bam-js/compare/v1.0.4...v1.0.5) (2018-10-16)

- Add a bugfix for pairing reads related to adding duplicate records to results

<a name="1.0.4"></a>

## [1.0.4](https://github.com/GMOD/bam-js/compare/v1.0.3...v1.0.4) (2018-10-13)

- Support pairing reads
- Fix pseudobin parsing containing feature count on certain BAM files

<a name="1.0.3"></a>

## [1.0.3](https://github.com/GMOD/bam-js/compare/v1.0.2...v1.0.3) (2018-09-25)

- Remove @gmod/tabix dependency

<a name="1.0.2"></a>

## [1.0.2](https://github.com/GMOD/bam-js/compare/v1.0.1...v1.0.2) (2018-09-25)

- Fix CSI indexing code

<a name="1.0.1"></a>

## [1.0.1](https://github.com/GMOD/bam-js/compare/v1.0.0...v1.0.1) (2018-09-24)

- Rename hasDataForReferenceSequence to hasRefSeq

<a name="1.0.0"></a>

# 1.0.0 (2018-09-24)

- Initial implementation of BAM parsing code
