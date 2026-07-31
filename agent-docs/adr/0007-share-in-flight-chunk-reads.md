# ADR 0007 — Concurrent queries share one in-flight chunk read

Status: Accepted

## Context

`chunkFeatureCache` is only populated once a chunk's read *finishes*. Until
then the key is absent, so `_cachedChunkFeatures` treated every caller as a
miss:

```ts
let entry = this.chunkFeatureCache.get(cacheKey)
if (!entry) {
  entry = await this._readChunkFeatures(chunk, opts)
  this.chunkFeatureCache.set(cacheKey, entry)
}
```

Two queries that overlap *in time* therefore both downloaded and both inflated
the same chunk, and the second `set` simply overwrote the first. The cache
protects against re-reading a chunk later; nothing protected against reading it
twice at once.

That is not a rare interleaving — it is the primary consumer's normal access
pattern. `jbrowse-components` renders a row of adjacent blocks, and
`BamAdapter.getFeatures` issues one `getRecordsForRange` per block with no
serialization between them. Those per-block ranges collapse onto very few chunk
keys, because `blocksForRange` maps a whole bin to one chunk and
`optimizeChunks` merges neighbours on top of that.

Measured on `shortreads_300x.bam`, 8 adjacent 3kb windows tiling the file's data
span — the shape of one jbrowse block row:

| | decompressions | inflated | wall clock |
| ---------------- | -------------- | -------- | ---------- |
| issued serially | 3 | 29.4 MB | 113 ms |
| issued concurrently | **9** | **85.5 MB** | **240 ms** |

All 8 queries resolve to **3 distinct chunk keys**, so 6 of those 9 inflates were
pure waste. Concurrency made the query *slower than doing it serially* — the
opposite of what a caller fanning out expects. Decompression is 70–90% of a cold
query (ADR 0003), so this was the largest remaining avoidable cost in the
library.

## Decision

Track reads that are still running in `inFlightChunks`, keyed the same way as
the cache. A caller that misses the cache but finds an in-flight entry awaits
that promise instead of starting a second read. Entries are removed when the
read settles; the resolved features land in `chunkFeatureCache` as before.

## Consequences / rationale

- **Concurrent overlapping queries cost what the serial ones do.** Same
  benchmark: 9 → 3 decompressions, 85.5 → 29.4 MB inflated, 240 → 86 ms.
  Concurrent is now *faster* than serial (86 vs 105 ms), as it should be.

- **Single-query performance is unchanged.** The added work on a miss is one
  `Map` set and one delete. Interleaved A/B, alternating implementations within
  one process, 15 iterations: identical within noise on `out.bam`,
  `shortreads_300x.bam` and `chr22_nanopore_subset.bam`.

- **It strengthens ADR 0006 rather than weakening it.** Sharing was already the
  rule for records that come from the cache; this makes it hold for records that
  come from a concurrent read too, so there is no longer a timing-dependent case
  where two queries get independently-decoded copies of one chunk.

- **A joined read is not hostage to the joiner's abort.** `opts.signal` is
  per-caller, and only the caller that *starts* the read passes its signal down
  to `bam.read`. If that owner aborts, the shared promise rejects for everyone —
  including queries that are still live. Waiters therefore compare the failed
  read's signal against their own, and redo the read under their own `opts` when
  the failure was somebody else's abort. Every other failure, and the waiter's
  own abort, propagates unchanged.

  A sibling waiter may reach that retry first, so the retry path re-checks
  `inFlightChunks` and joins an existing retry rather than starting a third read.

  In practice this path is cold: jbrowse does not pass a `signal` to
  `getRecordsForRange` at all — it cancels with `checkStopToken` around the
  await — so its concurrent queries all share `signal: undefined` and the
  comparison never fires.

## Rejected alternatives

- **Caching the promise instead of the resolved entry.** The byte-budget LRU
  needs `entry.bytes` to do its accounting, which is only known after the read
  resolves. Storing promises in `ChunkFeatureCache` would mean either an
  unbudgeted window or teaching the LRU to hold unsized entries; a separate
  short-lived map keeps the budget logic exactly as it was.

- **Serializing chunk reads behind a global queue.** It would also collapse the
  duplicate work, but by removing the concurrency instead of sharing it — which
  gives up the parallel-fetch win in ADR 0008.

- **Fixing it in `jbrowse-components` by de-duplicating at the adapter.** The
  adapter cannot know that two different coordinate ranges map to one chunk;
  that is index knowledge and it lives here. Any other consumer fanning out
  would hit the same cost.
