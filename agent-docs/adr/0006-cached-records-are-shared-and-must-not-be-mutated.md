# ADR 0006 — Cached records are shared between queries, and callers must not mutate them

Status: Accepted

## Context

`chunkFeatureCache` caches **decoded record objects**, not the buffer they were
decoded from. `_cachedChunkFeatures` returns `entry.features` — the same array of
the same `BamRecord` instances — to every query that resolves to that chunk key.

So two `getRecordsForRange` calls can hand the caller *the same object*. Not a
rare edge: it happens whenever the queries produce the same merged chunk span,
which includes re-querying one range and two nearby ranges covered by one chunk.

That is easy to miss, because two *different* ranges usually produce different
chunk keys (`optimizeChunks` merges per query — see ADR 0001's "Known residual"),
so the cache misses and each query decodes its own copy. The sharing only shows
up once the keys coincide.

It also got much more likely in 7.5.0. Before
`bde84b1 perf: keep every chunk a query parses cached` (ADR 0001) the
`evictOverlappingChunks` rule left roughly one entry cached per query, so
cross-query sharing was close to accidental. Removing it made retention the norm
— which is the whole point of that change, and the reason this contract now
needs stating.

**This bit jbrowse-components twice.** Its BAM adapter resolved the reference for
reads lacking an `MD` tag by writing onto the record:

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
  sharing them across queries is the point, not a hazard. "Read-only" is a
  contract about the *caller's* fields, not about internal immutability — which
  is also why freezing records is not available as an enforcement mechanism.

## Rejected alternatives

- **Cache the inflated buffer instead of the records** (keep `data` /
  `cpositions` / `dpositions` in the entry, re-run `readBamFeatures` per query).
  This is the principled fix — every caller gets its own objects and the hazard
  disappears library-wide — and it keeps the expensive half of the cache, since
  the download and the inflate still only happen once.

  It costs the record scan on every warm query. Measured on this machine,
  min-of-40 after 15 warmup rounds, re-running `readBamFeatures` over the
  buffers a warm query already holds. The warmup matters: timing this cold
  reports the scan about 2x too expensive, and the whole difference is JIT.

  | file                      | records | warm now | + scan   | ratio |
  | ------------------------- | ------- | -------- | -------- | ----- |
  | shortreads_300x.bam       | 53,596  | ~3-5 ms  | ~7-11 ms | ~2.3x |
  | chr22_nanopore_subset.bam | 757     | ~0.1 ms  | ~0.2 ms  | ~2x   |

  Only the shortreads row carries weight. At 757 records the nanopore case is
  tenths of a millisecond either way, so its ratio is noise around a number too
  small to care about; it is listed to show the cost tracks record count rather
  than file size.

  A warm query on a dense short-read region roughly doubles. ADR 0001 bought
  19.6x there; this would give back a real slice of it, permanently, for every
  consumer — to defend against a mistake that one consumer made and has fixed.
  The scan is already near its floor (~0.1 µs/record, dominated by object
  allocation), so there is no obvious way to make it cheap enough to reconsider.

- **Return `readonly T[]`.** Free, but it prevents mutating the *array*, not the
  records' fields, which is the actual failure. It would signal intent at the
  cost of type churn for every consumer and stop none of the bugs above.

- **Freeze the records.** Would have thrown on the assignment immediately, but
  `BamRecord` memoizes on itself (see above), so freezing breaks its own lazy
  getters.

## Known residual

Nothing enforces this — it is a documented contract. The two places it matters
most (`getRecordsForRange`, the public entry point, and `_cachedChunkFeatures`,
where the sharing actually happens) carry a comment pointing here.
