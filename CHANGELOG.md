## [8.4.1](https://github.com/GMOD/bam-js/compare/v8.4.0...v8.4.1) (2026-08-10)

### Chores

- Gate preversion on format:check, as CI does
- Gate preversion on typecheck too, as CI does
- Converge package.json on the shape its siblings use

### Other Changes

- Revert "chore: converge package.json" — the CHANGELOG prettier step

Removes `prettier --write CHANGELOG.md` from the `version` script, which the
previous commit added on a premise I did not check.

The reasoning was: git-cliff writes CHANGELOG.md after `preversion` has run, so
the format:check gate structurally cannot see it, while CI checks it on the tag
commit -- a hole the gate cannot cover. The first half is true. The second is
not: **every one of the 20 repos already lists CHANGELOG.md in
.prettierignore**, so CI's format:check skips it too and there was never a hole.

The step was also a no-op, verified rather than assumed: prettier skips an
ignored file even when it is named explicitly on the command line, so a
deliberately mangled CHANGELOG.md came back unchanged.

hclust was the only repo that had this step, which is where I copied it from.
It is reverted there too. The .prettierignore comments in bgzf-filehandle,
cram-js and hclust say why nobody should add it back: reformatting a generated
changelog fights the generator on every release.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

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
