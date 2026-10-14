# ADR 0009 — Answering "isn't the concurrent chunk fetch overcomplicated?"

Status: Accepted

## Context

Before ADRs 0007 and 0008, fetching a query's chunks was a five-line `for` loop
with an `await` in the body. The fetch is now about 45 lines of mechanism in
`_startChunkRead`, `_cachedChunkFeatures` and `_fetchChunkFeatures`: an
in-flight map keyed by chunk, a signal comparison, a retry, a bounded worker
pool, a per-chunk result slot and a single-chunk fast path.

Calling that diff overcomplicated is the correct instinct, and "the benchmarks
say so" is not enough of an answer to it. This ADR takes each piece, names the
simpler code it replaced, and gives what that simpler code costs. It also names
the one piece that is close to the line, and the condition under which we should
delete it.

## The short answer

The design follows from two facts about the primary consumer:

- **jbrowse issues one `getRecordsForRange` per rendered block, concurrently,
  with no serialization.** Those per-block ranges map to very few chunk keys.
  Without in-flight sharing, 8 adjacent windows cost 9 decompressions instead of
  3, and concurrency made the query _slower than doing it serially_ (240 ms vs
  113 ms — ADR 0007).
- **One query spans ~15 chunks, and each chunk is a separate HTTP range
  request.** Read serially, that is ~15 round trips: 734 ms vs 192 ms at a 50 ms
  RTT, with an identical request and byte count either way (ADR 0008).

The per-block fan-out and the ~15-chunk query are what the library's main
consumer does, on the transport it ships against, so neither is a
micro-optimization or a hypothetical case. The rest of the code is bookkeeping
that these two patterns require.

## Piece by piece

### "Just use `Promise.all(chunks.map(...))`"

`Promise.all` is the unbounded version, and it is shorter. The worker pool only
caps concurrency at 6.

`blocksForRange` over a whole chromosome returns hundreds of chunks, and every
chunk inflated is a decompressed buffer pinned for as long as any record views
into it. Without the cap, the loop inflates all of them at once. In a browser,
the transport that matters, the cap changes nothing, because browsers allow 6
connections per host anyway, so requests 7..N would queue in the browser instead
of in our loop.

Five lines of code turn an unbounded memory spike into a queue, which is worth
it.

When this ADR was first written, `fetchPairs` still fanned out over mate chunks
with an unbounded `Promise.all`, and the ADR noted the inconsistency. A
`viewAsPairs` query over a busy region resolves to many distinct mate chunks, so
the memory argument above applied there verbatim. `fetchPairs` now uses the same
inline pool, capped by the same `MAX_CONCURRENT_CHUNK_READS`.

The chunk deduplication in `fetchPairs` moved at the same time, from
`Chunk.toString()` to `chunkCacheKey()`, the key `_cachedChunkFeatures` uses.
`toString()` folds in `bin` and `fetchedSize()`, so two chunks covering an
identical virtual-offset span stayed separate entries in the mate map, even
though the cache below stores them as one entry, and their records came back
twice.

### "Then at least extract a generic `mapConcurrent` helper"

We tried a `mapConcurrent(items, limit, fn)` helper in place of the inline pool,
measured it and rejected it. The helper adds an async frame per chunk, and the
cost is visible on warm queries:

|                         | tiny.bam (1 chunk) | out.bam (14 chunks) |
| ----------------------- | ------------------ | ------------------- |
| helper vs inline, run 1 | 1.095x             | 1.127x              |
| helper vs inline, run 2 | 1.125x             | 1.152x              |
| helper vs inline, run 3 | 1.102x             | 1.108x              |

The benchmark is an interleaved A/B: both implementations alternate within one
process, with the order rotated per round, and the result is the min of 9
rounds. The regression keeps its sign across runs, which by the methodology in
ADR 0008 makes it real. The same measurement on the inline pool flips sign from
run to run (0.99, 1.30, 1.07 on `out.bam`), which is the pattern noise produces
here.

The helper would save fifteen lines and cost 11% on the hot path, and that path
is what the library is for, so the inline pool stays.

### "The single-chunk fast path is premature optimization"

We added the six-line fast path because `tiny.bam` regressed ~7% when the pool
went in, consistently and in both slot orders (ADR 0008). Every small file, and
every query that falls inside a single bin, reads one chunk, so the case is
common.

### "The abort retry is speculative complexity"

The abort retry is the piece closest to the line, and the criticism has real
force. jbrowse does not pass a `signal` to `getRecordsForRange` at all, and
cancels with `checkStopToken` around the await instead, so in the main consumer
this path never fires.

We kept the retry because sharing _introduces_ a failure mode that did not exist
before. Only the caller that starts a read passes its signal down to `bam.read`.
If that caller aborts, the shared promise rejects for every waiter, including
queries that are still running. A query that fails because an unrelated query
was cancelled is a correctness regression the optimization itself introduced,
and eight lines that avoid it are cheap.

Until this ADR, the retry was also the one part of the feature with **no test at
all**: the subtlest branch in the fetch path, with only reasoning to show that
it worked. Three tests now cover it
(`a waiter survives the read owner aborting`,
`a waiter's own abort still propagates`,
`a genuine read failure is not retried by waiters`). Each test drives the case
with a read that hangs until the test releases it, so the interleaving is
deterministic.

We checked the tests by mutation, because a concurrency test that cannot fail is
worse than none. Removing the retry fails only the first test, and retrying
unconditionally fails only the third. Each branch of the guard is covered by
exactly one test.

Review removed two pieces of the retry that look necessary and are not:

- `pending.signal !== opts.signal` was **redundant**. If the two are the same
  object and it is aborted, then `opts.signal.aborted` is true, so the "did _we_
  abort?" clause already rejects the retry. The identity check could never
  change the outcome.
- The explicit "a sibling waiter may already have started the retry, so join
  that instead" branch was **re-implementing the function it was inside**.
  Recursing into `_cachedChunkFeatures` handles that case and also re-checks
  `chunkFeatureCache`, which may be populated by then.

### "Why is `inFlightChunks` a second map instead of part of the cache?"

`ChunkFeatureCache`'s budget is in decompressed bytes, and `entry.bytes` is
known only once the read resolves, as ADR 0007's rejected alternatives record.
To store promises there, we would have to accept an unbudgeted window or teach
the LRU to hold unsized entries. A short-lived side map leaves the budget logic
untouched.

### "Fix it in jbrowse instead"

As ADR 0007 records, the adapter has no way to tell that two different
coordinate ranges map to one chunk, because that mapping comes from the index,
which bam-js reads. Any other consumer that fans out pays the same cost.

## What would make this smaller

If the trade-offs change, these changes would shrink the code:

- **Serialize chunk reads behind a global queue.** A global queue removes the
  duplicate work without the in-flight map, but it does so by removing
  concurrency, which gives up all of ADR 0008.
- **Stop forwarding `opts.signal` to `bam.read`,** or refcount waiters and abort
  only when all of them have. Either change makes the abort retry dead code, and
  deleting the retry removes `InFlightChunk` entirely, leaving `inFlightChunks`
  a map of bare promises. The retry is the one piece with a clear deletion
  trigger.
- **Drop the single-chunk fast path** if the pool ever gets cheap enough that
  `tiny.bam` shows parity. Re-measure before assuming it has.

## Consequences

- The mechanism is ~45 non-comment lines, and each piece has a measurement in
  these ADRs, because first principles alone would not justify any of them.
- To remove a piece, show that the simpler code is equivalent or that the
  measurement no longer reproduces, as review did for the two pieces above. A
  piece looking like too much is not a reason to remove it.
