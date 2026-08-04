# ADR 0010 — Stopping a query once a chunk is past its range

Status: Proposed (measured, implemented once, backed out — see "Why not yet")

## Context

`getRecordsForRange` reads every chunk `blocksForRange` returns. On most files
that is right, because every chunk holds records the query wants. On long-read
files it is badly wrong, and the reason is the BAI linear index.

`getLowestChunk` returns `linearIndex[min >> 14]`, the smallest file offset of
any record overlapping that 16kb window, and `optimizeChunks` drops chunks
entirely below it. That lower bound is the only thing narrowing a query to its
region. One ultra-long read spanning a large span pins it near the start of the
file, and then it narrows nothing:

```
chr22_nanopore_subset.bam.bai   ref=21   1020 linear entries, 0 unset
  pos 16,000,000 -> linearIndex[976]  = 9603
  pos 16,400,000 -> linearIndex[1000] = 9603
```

9603 bytes into a 14MB file. So a narrow window inherits every chunk of every
overlapping bin, at every level of the binning scheme:

| window | chunks | fetched | records returned |
| ------- | ------ | ------- | ---------------- |
| 10kb    | 22     | 9.3MB   | 0                |
| 100kb   | 22     | 9.3MB   | 0                |
| 400kb   | 9      | 11.9MB  | 35               |
| 1000kb  | 3      | 13.6MB  | 757              |

A 10kb window costs 22 range requests and 66% of the file to answer with
nothing. Note the inversion: the 1Mb window — 100x larger — costs *three*
requests, because more chunks bridge more gaps and `optimizeChunks` merges them.

This is not a bam-js bug. htslib's BAI iterator has the same lower bound. What
htslib has that bam-js does not is **early termination**: it walks chunks in
order and stops as soon as a record's position passes the query end, so the
later chunks are never read. bam-js fetches all of a query's chunks up front
(ADR 0008), so it cannot stop.

## The available saving

Chunks come back from `optimizeChunks` sorted by `minv.blockPosition`, and a
coordinate-sorted BAM stores records in `(ref_id, start)` order. So chunk `i`'s
first record is at or before chunk `i+1`'s, and **a chunk whose first record is
already past the query has only past-the-query records behind it**.

That coordinate-sorted assumption is not new. `appendInRange` already breaks out
of a chunk on exactly it — "stop scanning once we pass `max` within `chrId` or
move past `chrId` entirely". Applying it one level up is the same assumption,
consistently applied. A BAM that violates it already returned short results.

Measured: how many chunks a query would need if it stopped at the first chunk
whose first record starts at/after `max`. No case showed a non-monotonic chunk
order.

| file / window                     | chunks | fetched | needed | saving |
| --------------------------------- | ------ | ------- | ------ | ------ |
| chr22_nanopore 10kb               | 22     | 9.3MB   | 1      | ~95%   |
| chr22_nanopore 100kb              | 22     | 9.3MB   | 1      | ~95%   |
| chr22_nanopore 400kb              | 9      | 11.9MB  | 3      | 20%    |
| ultra-long-ont 400kb              | 12     | 5.7MB   | 1      | ~90%   |
| ultra-long-ont 1000kb             | 12     | 5.7MB   | 2      | 50%    |
| volvox 10kb                       | 3      | 0.3MB   | 2      | 43%    |
| shortreads_300x, out.bam, volvox 100kb | 1-2 | -      | all    | 0%     |

The win is concentrated exactly where the linear index degenerates: long reads,
narrow windows. Short-read files and wide windows get nothing, because they
need every chunk they were given.

## Why not yet

Implemented as a `stopAfter` index shared by the worker pool in
`_fetchChunkFeatures`: a worker that finds `features[0]` past the query lowers
`stopAfter`, and workers stop claiming indices at or beyond it. Results were
correct — all record-count assertions, including the ten pinned benchmark
regions, were unchanged.

**It was backed out because the stop index depends on worker scheduling.**
`test/cache.test.ts` caught it: running the identical query twice parsed 6
chunks and then 9. On a warm cache `_cachedChunkFeatures` resolves without I/O,
so workers claim indices far faster than any of them can set `stopAfter`. The
second query therefore does *more* I/O than the first, and the cache grows on
repeat queries — which breaks the panning property ADR 0001 exists to protect.

The obvious fix — process chunks in fixed waves of `MAX_CONCURRENT_CHUNK_READS`
and check the stop condition at each wave boundary — is deterministic, because
wave boundaries are set by index rather than timing. But it reintroduces a
barrier: the slowest chunk in a wave gates the next wave, which is precisely
what the work-stealing pool in ADR 0008 was measured to avoid.

So the decision is a real trade, not an oversight:

- **work-stealing pool** — best latency when every chunk is needed (the common
  case), but no deterministic early stop.
- **fixed waves** — deterministic early stop worth up to 95% of the I/O on
  long-read narrow windows, at the cost of a barrier on every query.
- **do nothing** — long-read narrow windows keep paying for the whole bin.

Whichever is chosen needs a benchmark of waves-vs-pool on the files where *no*
early stop is possible, since that is what the change would tax. That
measurement has not been done, and shipping either half of it on intuition is
how the 7.7.0 linear-index regression happened.

## Notes for whoever picks this up

- The predicate must check `ref_id` as well as `start`: `optimizeChunks` merges
  spans up to 5MB, which can carry a chunk across a reference boundary in the
  file. `first.ref_id > chrId || (first.ref_id === chrId && first.start >= max)`.
- An empty chunk says nothing about position and must never stop the walk.
- `onProgress` reports against a total computed from all chunks, so an early
  stop needs a final `onProgress(totalBytes, totalBytes)` or a determinate bar
  never reaches its end.
- `featureLists` becomes sparse, so the append loop must skip holes.
- CSI is unaffected in principle but untested here: `getLowestChunk` returns 0:0
  for CSI, so it never narrows anything and the same win should be available.
