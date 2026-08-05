# ADR 0007 — Concurrent queries share one in-flight chunk read

Status: Accepted

## Context

`chunkFeatureCache` is only populated once a chunk's read _finishes_. Until then
the key is absent, so `_cachedChunkFeatures` treated every caller as a miss:

```ts
let entry = this.chunkFeatureCache.get(cacheKey)
if (!entry) {
  entry = await this._readChunkFeatures(chunk, opts)
  this.chunkFeatureCache.set(cacheKey, entry)
}
```

Two queries that overlap _in time_ therefore both downloaded and both inflated
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

|                     | decompressions | inflated    | wall clock |
| ------------------- | -------------- | ----------- | ---------- |
| issued serially     | 3              | 29.4 MB     | 113 ms     |
| issued concurrently | **9**          | **85.5 MB** | **240 ms** |

All 8 queries resolve to **3 distinct chunk keys**, so 6 of those 9 inflates
were pure waste. Concurrency made the query _slower than doing it serially_ —
the opposite of what a caller fanning out expects. Decompression is 70–90% of a
cold query (ADR 0003), so this was the largest remaining avoidable cost in the
library.

## Decision

Track reads that are still running in `inFlightChunks`, keyed the same way as
the cache. A caller that misses the cache but finds an in-flight entry awaits
that promise instead of starting a second read. Entries are removed when the
read settles; the resolved features land in `chunkFeatureCache` as before.

## Consequences / rationale

- **Concurrent overlapping queries cost what the serial ones do.** Same
  benchmark: 9 → 3 decompressions, 85.5 → 29.4 MB inflated, 240 → 86 ms.
  Concurrent is now _faster_ than serial (86 vs 105 ms), as it should be.

- **Single-query performance is unchanged.** The added work on a miss is one
  `Map` set and one delete. Interleaved A/B, alternating implementations within
  one process, 15 iterations: identical within noise on `out.bam`,
  `shortreads_300x.bam` and `chr22_nanopore_subset.bam`.

- **It strengthens ADR 0006 rather than weakening it.** Sharing was already the
  rule for records that come from the cache; this makes it hold for records that
  come from a concurrent read too, so there is no longer a timing-dependent case
  where two queries get independently-decoded copies of one chunk.

- **A joined read is not hostage to another caller's abort.** A shared read is
  not cancelled when one of its callers gives up, only when _all_ of them have.
  `InFlightChunk` holds the set of signals still waiting on it and an
  `AbortController` of its own; `_readChunkFeatures` runs under that controller,
  and it fires only once the last waiting signal has aborted. A caller's own
  abort is reported to that caller alone, by re-checking it after the shared
  promise settles.

  A caller with **no signal cannot give up**, so it pins the read: there is no
  set of aborts that should stop it. That is the honest reading of a caller that
  never asked to be cancellable, and it means one signal-free query makes that
  chunk's read uncancellable for everyone joined to it.

  **This replaced a retry**, and the reasons are worth keeping. Originally the
  read ran under whichever caller started it, and a waiter that saw it fail
  because _that_ caller aborted redid the read under its own `opts`. It was
  correct, but it threw away work in the case that matters: a pan cancels the
  query in flight while the next query wants most of the same chunks, so exactly
  the chunks still being read got read twice. The retry also recursed unbounded
  — jbrowse's own `RemoteFileWithRangeCache.joinChunk`, the same retry one layer
  further down on 256 KiB chunks, bounds its version at one attempt precisely to
  avoid a recursion whose depth depends on how the aborts interleave.

  `@gmod/cram` reached the same design independently and at the same time; see
  its ADR 0003. The two now match, which is the point — a consumer threading one
  stop token through both adapters gets the same cancellation semantics from
  each.

  An earlier version of this note said the path was cold, because "jbrowse does
  not pass a `signal` to `getRecordsForRange` at all". That is no longer true:
  `BamAdapter.getFeatures` wraps the read in `withStopTokenSignal` and threads a
  real signal down. The path is hot on every pan.

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
