# ADR 0009 — Answering "isn't the concurrent chunk fetch overcomplicated?"

Status: Accepted

## Context

Before ADRs 0007 and 0008, fetching a query's chunks was a `for` loop with an
`await` in the body — five lines. It is now an in-flight map keyed by chunk, a
signal comparison, a retry, a bounded worker pool, a per-chunk result slot and a
single-chunk fast path: about 45 lines of mechanism in `_startChunkRead`,
`_cachedChunkFeatures` and `_fetchChunkFeatures`.

"This is overcomplicated" is the correct instinct to have about that diff, and
it deserves an answer better than "the benchmarks say so". This ADR takes each
piece, names the simpler thing it replaced, and gives what that simpler thing
actually costs. It also names the one piece that is genuinely close to the line,
and the condition under which it should be deleted.

## The short answer

Two facts about the primary consumer drive everything else:

- **jbrowse issues one `getRecordsForRange` per rendered block, concurrently,
  with no serialization.** Those per-block ranges collapse onto very few chunk
  keys. Without in-flight sharing, 8 adjacent windows cost 9 decompressions
  instead of 3 and concurrency made the query *slower than doing it serially*
  (240 ms vs 113 ms — ADR 0007).
- **One query spans ~15 chunks, each its own HTTP range request.** Read
  serially that is ~15 round trips: 734 ms vs 192 ms at a 50 ms RTT, with an
  identical request and byte count either way (ADR 0008).

Neither is a micro-optimization and neither is hypothetical — they are the
normal access pattern of the library's main consumer, on the transport it
actually ships against. The rest of the code is bookkeeping those two facts
force.

## Piece by piece

### "Just use `Promise.all(chunks.map(...))`"

That is the unbounded version, and it is genuinely shorter — the worker pool
exists only to cap concurrency at 6.

What the cap buys: `blocksForRange` over a whole chromosome returns hundreds of
chunks, and every chunk inflated is a decompressed buffer pinned for as long as
any record views into it. Unbounded, that inflates all of them at once. What
the cap costs: nothing on the transport that matters — browsers cap at 6
connections per host anyway, so requests 7..N would queue in the browser rather
than in our loop.

Five lines to convert an unbounded memory spike into a queue is a good trade.

Note the inconsistency this leaves: `fetchPairs` still fans out over mate chunks
with an unbounded `Promise.all`. Same argument applies there; it has not been
changed only because it is a separate behaviour change.

### "Then at least extract a generic `mapConcurrent` helper"

Tried, measured, rejected. Replacing the inline pool with a
`mapConcurrent(items, limit, fn)` helper costs an extra async frame per chunk,
and that is visible on warm queries:

| | tiny.bam (1 chunk) | out.bam (14 chunks) |
| ----------------------- | ------------------ | ------------------- |
| helper vs inline, run 1 | 1.095x | 1.127x |
| helper vs inline, run 2 | 1.125x | 1.152x |
| helper vs inline, run 3 | 1.102x | 1.108x |

Interleaved A/B, both implementations alternating within one process with the
order rotated per round, min of 9 rounds. The regression keeps its sign across
runs; by the methodology in ADR 0008 that makes it real, not an artifact. The
same measurement on the inline pool flips sign run to run (0.99, 1.30, 1.07 on
`out.bam`), which is what noise looks like here.

Fifteen lines saved is not worth 11% on the hot path of a library whose whole
point is that path.

### "The single-chunk fast path is premature optimization"

It is six lines, and it was not written speculatively — it was added because
`tiny.bam` regressed ~7% when the pool went in, consistently and in both slot
orders (ADR 0008). One chunk is not an edge case: it is every small file and
every query that lands inside a single bin.

### "The abort retry is speculative complexity"

This is the piece closest to the line, and the criticism has real force: jbrowse
does not pass a `signal` to `getRecordsForRange` at all — it cancels with
`checkStopToken` around the await — so in the main consumer this path never
fires.

It stays because sharing *introduces* a failure mode that did not exist before
it. Only the caller that starts a read passes its signal down to `bam.read`; if
that caller aborts, the shared promise rejects for every waiter, including
queries that are perfectly alive. A query failing because an unrelated query was
cancelled is a correctness regression caused by the optimization, not a
pre-existing risk the optimization declined to fix. Eight lines to not introduce
it is cheap.

It was also, until now, the one part of the feature with **no test at all** —
the subtlest branch in the fetch path, held up by reasoning alone. Three tests
now cover it (`a waiter survives the read owner aborting`, `a waiter's own abort
still propagates`, `a genuine read failure is not retried by waiters`), each
driving the case with a read that hangs until the test releases it, so the
interleaving is deterministic rather than raced.

They were checked by mutation, because a concurrency test that cannot fail is
worse than none: removing the retry kills only the first, and retrying
unconditionally kills only the third. Each branch of the guard has exactly one
test holding it down.

It did shrink under review, and the two things that came out are worth
recording because they read as necessary and were not:

- `pending.signal !== opts.signal` was **redundant**. If the two are the same
  object and it is aborted, then `opts.signal.aborted` is true, so the
  "did *we* abort?" clause already rejects the retry. The identity check could
  never change the outcome.
- The explicit "a sibling waiter may already have started the retry, so join
  that instead" branch was **re-implementing the function it was inside**.
  Recursing into `_cachedChunkFeatures` covers it, and covers more: it also
  re-checks `chunkFeatureCache`, which by then may be populated.

### "Why is `inFlightChunks` a second map instead of part of the cache?"

Covered in ADR 0007's rejected alternatives: `ChunkFeatureCache`'s budget is in
decompressed bytes, and `entry.bytes` is only known once the read resolves.
Storing promises there means either an unbudgeted window or teaching the LRU to
hold unsized entries. A short-lived side map keeps the budget logic untouched.

### "Fix it in jbrowse instead"

Covered in ADR 0007: the adapter cannot know that two different coordinate
ranges map to one chunk. That is index knowledge and it lives here, and any
other consumer that fans out hits the same cost.

## What would actually make this smaller

Honest list, in case the trade-offs change:

- **Serialize chunk reads behind a global queue.** Collapses the duplicate work
  without the in-flight map, but by removing concurrency rather than sharing it
  — it gives up all of ADR 0008.
- **Stop forwarding `opts.signal` to `bam.read`,** or refcount waiters and abort
  only when all of them have. Either makes the abort retry dead code, and
  deleting it removes `InFlightChunk` entirely — `inFlightChunks` becomes a map
  of bare promises. That is the one piece with a clear deletion trigger.
- **Drop the single-chunk fast path** if the pool ever gets cheap enough that
  `tiny.bam` shows parity. Re-measure before assuming it has.

## Consequences

- The mechanism is ~45 non-comment lines and each piece has a measurement
  attached. None of it is defensible from first principles alone, which is why
  these ADRs exist.
- Anything removed from it should be removed the way the two clauses above were:
  by showing the simpler code is equivalent or that the measurement no longer
  reproduces — not by asserting it looks like too much.
