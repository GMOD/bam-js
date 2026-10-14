# ADR 0006 — Cached records are shared between queries, and callers must not mutate them

Status: Accepted

## Context

`chunkFeatureCache` caches **decoded record objects**, not the buffer they were
decoded from. `_cachedChunkFeatures` returns `entry.features` — the same array
of the same `BamRecord` instances — to every query that resolves to that chunk
key.

Two `getRecordsForRange` calls can therefore return _the same object_ to the
caller. The sharing is common, and happens whenever the queries produce the same
merged chunk span, which includes re-querying one range and two nearby ranges
covered by one chunk.

The sharing is easy to miss, because two _different_ ranges usually produce
different chunk keys (`optimizeChunks` merges per query; see ADR 0001's "Known
residual"), so the cache misses and each query decodes its own copy. The sharing
only shows up once the keys coincide.

Sharing also became much more likely in 7.5.0. Before
`bde84b1 perf: keep every chunk a query parses cached` (ADR 0001) the
`evictOverlappingChunks` rule left roughly one entry cached per query, so
cross-query sharing was close to accidental. Removing the rule made retention
the norm, as ADR 0001 intended, so this contract now needs stating.

**Shared records broke jbrowse-components twice.** Its BAM adapter resolved the
reference for reads lacking an `MD` tag by writing onto the record:

```js
record.ref = regionSeq
record.refOffset = record.start - span.start
```

A display fetches all its needed regions at once, so the last fetch to resolve
rebound the read for every other region still holding it, and a read overlapping
two regions had one region's mismatches resolved against the other's sequence.
Both adapters (BAM, and its own text-SAM adapter with an equivalent cache) now
emit a small per-fetch wrapper instead.

## Decision

Keep caching decoded records. Document that they are shared and read-only to the
caller: per-query state belongs on a wrapper the caller owns, never on the
record.

## Consequences / rationale

- **Callers own no record.** Anything a caller wants to attach for the duration
  of one query — a resolved reference slice, a display id, a filter verdict —
  goes on a wrapper around the record, not on the record.

- **The library's own lazy memos are unaffected.** `_cachedEnd`, `_cachedTags`,
  `_cachedNumericCigar` and friends are pure functions of the record's bytes, so
  sharing them across queries is intended and safe. "Read-only" is a contract
  about the _caller's_ fields, not about internal immutability. The memos are
  also why freezing the records cannot enforce the contract.

## Rejected alternatives

- **Cache the inflated buffer instead of the records** (keep `data` /
  `cpositions` / `dpositions` in the entry, re-run `readBamFeatures` per query).
  Every caller would get its own objects, so the hazard would disappear
  library-wide, which makes this the principled fix. It also keeps the expensive
  half of the cache, since the download and the inflate still happen only once.

  The buffer cache costs a record scan on every warm query. We measured the scan
  on this machine, min-of-40 after 15 warmup rounds, by re-running
  `readBamFeatures` over the buffers a warm query already holds. Without the
  warmup, a cold timing reports the scan about 2x too expensive, and JIT
  accounts for the whole difference.

  | file                      | records | warm now | + scan   | ratio |
  | ------------------------- | ------- | -------- | -------- | ----- |
  | shortreads_300x.bam       | 53,596  | ~3-5 ms  | ~7-11 ms | ~2.3x |
  | chr22_nanopore_subset.bam | 757     | ~0.1 ms  | ~0.2 ms  | ~2x   |

  Only the shortreads row matters, because at 757 records the nanopore case is
  tenths of a millisecond either way and its ratio is noise around a number too
  small to care about. The table lists it to show that the cost tracks record
  count rather than file size.

  A warm query on a dense short-read region roughly doubles. ADR 0001 made that
  query 19.6x faster, and the buffer cache would give back a real part of the
  gain, permanently and for every consumer, to defend against a mistake that one
  consumer made and has fixed. The scan is already near its floor (~0.1
  µs/record, dominated by object allocation), so there is no obvious way to make
  it cheap enough to reconsider.

- **Return `readonly T[]`.** The type costs nothing at runtime, but it prevents
  mutating the _array_, not the records' fields, and the bugs above mutated the
  fields. It would signal intent at the cost of type churn for every consumer,
  and it stops none of those bugs.

- **Freeze the records.** A frozen record would have thrown on the assignment
  immediately, but `BamRecord` memoizes on itself (see above), so freezing
  breaks its own lazy getters.

## Known residual

The read-only contract is documented, not enforced in code. The two places it
matters most (`getRecordsForRange`, the public entry point, and
`_cachedChunkFeatures`, where the sharing happens) have a comment pointing here.
