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
protected against re-reading a chunk later, but no code protected against
reading it twice at once.

Overlapping queries are the primary consumer's normal access pattern.
`jbrowse-components` renders a row of adjacent blocks, and
`BamAdapter.getFeatures` issues one `getRecordsForRange` per block with no
serialization between them. Those per-block ranges map to very few chunk keys,
because `blocksForRange` maps a whole bin to one chunk and `optimizeChunks`
merges neighbours on top of that.

Measured on `shortreads_300x.bam`, 8 adjacent 3kb windows tiling the file's data
span, which is the layout of one jbrowse block row:

|                     | decompressions | inflated    | wall clock |
| ------------------- | -------------- | ----------- | ---------- |
| issued serially     | 3              | 29.4 MB     | 113 ms     |
| issued concurrently | **9**          | **85.5 MB** | **240 ms** |

All 8 queries resolve to **3 distinct chunk keys**, so 6 of those 9 inflates
were pure waste. Concurrency made the query _slower than doing it serially_, the
opposite of what a caller fanning out expects. Decompression is 70–90% of a cold
query (ADR 0003), so this was the largest remaining avoidable cost in the
library.

## Decision

Track reads that are still running in `inFlightChunks`, keyed the same way as
the cache. A caller that misses the cache but finds an in-flight entry awaits
that promise instead of starting a second read. Entries are removed when the
read settles, and the resolved features are stored in `chunkFeatureCache` as
before.

## Consequences / rationale

- **Concurrent overlapping queries cost what the serial ones do.** Same
  benchmark: 9 → 3 decompressions, 85.5 → 29.4 MB inflated, 240 → 86 ms.
  Concurrent is now _faster_ than serial (86 vs 105 ms), as it should be.

- **Single-query performance is unchanged.** The added work on a miss is one
  `Map` set and one delete. An interleaved A/B, alternating implementations
  within one process over 15 iterations, found the two identical within noise on
  `out.bam`, `shortreads_300x.bam` and `chr22_nanopore_subset.bam`.

- **In-flight sharing strengthens ADR 0006 rather than weakening it.** Sharing
  was already the rule for records that come from the cache, and this makes it
  hold for records that come from a concurrent read too, so there is no longer a
  timing-dependent case where two queries get independently-decoded copies of
  one chunk.

- **One caller's abort does not cancel a joined read.** A shared read is
  cancelled only when _all_ of its callers have given up. `InFlightChunk` holds
  the set of signals still waiting on it and an `AbortController` of its own;
  `_readChunkFeatures` runs under that controller, and it fires only once the
  last waiting signal has aborted. A caller's own abort is reported to that
  caller alone, by re-checking it after the shared promise settles.

  A caller with **no signal cannot give up**, so it pins the read, because no
  set of aborts should stop a caller that never asked to be cancellable. One
  signal-free query therefore makes that chunk's read uncancellable for everyone
  joined to it.

  A caller whose signal has **already aborted** is the opposite case, and it
  must never be registered as a waiter. `addEventListener` never fires on a
  signal that aborted before the listener was added, so registering one leaves
  it in `signals`, where no code ever removes it. The count never reaches zero,
  and the read becomes uncancellable for everyone joined to it. Cancellation
  stops working with no error and nothing to observe.

  The first version of this design had exactly that bug, and it hit often. On a
  pan the abort fires while `blocksForRange` is still reading the index, and no
  code between there and `_cachedChunkFeatures` checks the signal (`bai.ts` and
  `csi.ts` never read it), so a whole batch of chunk reads reaches
  `_cachedChunkFeatures` already cancelled. Measured at the filehandle on
  `out.bam` `1:1-20000` with the abort fired during index I/O: all five chunk
  range requests ran on uncancellable, where the code this ADR replaced
  cancelled all five.

  The fix is an up-front `throwIfAborted` in `_cachedChunkFeatures`, before the
  cache lookup, in the same position and for the same reason as
  `SliceRecordCache.getOrFill` in `@gmod/cram`. `getRecordsForRange` checks too,
  which rejects a dead-on-arrival query without touching the index, but that
  check does not fix this bug, because the signal fires _after_ it.

  `joinChunkRead` then guards the case a second time on purpose. No call reaches
  that guard, because `_cachedChunkFeatures` rejects first, with no `await` in
  between. An invariant that fails with no error should not depend on a check
  twenty lines away, and this is the bug that shipped. `@gmod/cram` guards the
  same spot for the same reason, and `@gmod/abortable-promise-cache`, which both
  libraries reimplement rather than depend on, handles it in
  `AggregateAbortController.addSignal` by passing an already-aborted input
  straight to `handleAborted` instead of counting it as a waiter.

  The redundancy costs mutation coverage, because mutation testing catches
  neither check alone, since the other still produces correct behaviour. Only
  removing both reproduces the bug, and the tests catch that, because they
  assert the behaviour rather than either line.

  **The shared controller replaced a retry**, and this ADR keeps the reasons.
  Originally the read ran under whichever caller started it, and a waiter that
  saw it fail because _that_ caller aborted redid the read under its own `opts`.
  The retry was correct, but it threw away work in the common case. A pan
  cancels the query in flight while the next query wants most of the same
  chunks, so exactly the chunks still being read got read twice. The retry also
  recursed without bound. jbrowse's `RemoteFileWithRangeCache.joinChunk`, the
  same retry one layer further down on 256 KiB chunks, bounds its version at one
  attempt precisely to avoid a recursion whose depth depends on how the aborts
  interleave.

  `@gmod/cram` reached the same design independently and at the same time; see
  its ADR 0003. The two now match, so a consumer threading one stop token
  through both adapters gets the same cancellation semantics from each.

  An earlier version of this note said the path was cold, because "jbrowse does
  not pass a `signal` to `getRecordsForRange` at all". `BamAdapter.getFeatures`
  now wraps the read in `withStopTokenSignal` and threads a real signal down, so
  the path is hot on every pan.

## Rejected alternatives

- **Caching the promise instead of the resolved entry.** The byte-budget LRU
  needs `entry.bytes` to do its accounting, which is only known after the read
  resolves. Storing promises in `ChunkFeatureCache` would mean either an
  unbudgeted window or teaching the LRU to hold unsized entries; a separate
  short-lived map keeps the budget logic exactly as it was.

- **Serializing chunk reads behind a global queue.** A queue would also remove
  the duplicate work, but by removing the concurrency instead of sharing the
  read, which gives up the parallel-fetch win in ADR 0008.

- **Fixing it in `jbrowse-components` by de-duplicating at the adapter.** The
  adapter cannot know that two different coordinate ranges map to one chunk,
  because the mapping comes from the index, which bam-js reads. Any other
  consumer fanning out would hit the same cost.
