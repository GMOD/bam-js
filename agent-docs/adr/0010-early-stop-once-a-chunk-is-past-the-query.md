# ADR 0010 — Stopping a query once a chunk is past its range

Status: Accepted, implemented — one barrier after the first batch, then the
pool. See "The waves-vs-pool benchmark", which supersedes "Why not yet".

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

## The waves-vs-pool benchmark

Three schedulers, run against the real fixtures with identical record counts
asserted on every arm, min of 9 interleaved reps:

- **pool** — today's work-stealing loop, no early stop
- **waves** — fixed waves of 6 with a barrier, early stop *off*: isolates the
  cost of the barrier alone
- **waves+stop** — the proposal
- **pool+stop** — early stop without a barrier: the ceiling, if the
  determinism problem above were solved

### First, the thing that decides it: which queries can stop

Surveying every fixture for queries producing more than one wave found a
structural fact that changes the trade completely:

**Every query in the corpus with no early stop available has ≤ 4 chunks.**
`out.bam` whole (4), nanopore 2Mb (3), shortreads 2Mb (2), ultra-long whole (2).
Every query with more than 6 chunks has a stop available — 22, 22, 26, 21.

That is not a coincidence. `optimizeChunks` merges aggressively (65kb gap, 5MB
span), so a query that genuinely needs a lot of data gets it in a few big
chunks. A query with *many* chunks is one whose bins are scattered — which is
exactly the case where most of them are past the query.

So a barrier at 6-chunk boundaries is free on every no-stop query in the corpus:
with ≤ 4 chunks there is only one wave, and one wave **is** the pool. Measured
at 0.99x-1.06x on all four, as predicted.

### Then, the numbers

Two transport models, because the answer depends on which one you believe and
they bracket it. `bam.read` is delayed by a 50ms round trip plus transfer at
20MB/s.

**Per-connection bandwidth** (each concurrent read gets its own 20MB/s):

| query | chunks | pool | waves+stop | pool+stop | net |
| ----- | ------ | ---- | ---------- | --------- | --- |
| nanopore 100kb | 22 | 363ms | 355ms | 375ms | 1.02x |
| nanopore 20kb  | 22 | 348ms | 361ms | 341ms | 0.96x |
| out.bam 20kb   | 26 | 388ms | 252ms | 253ms | 1.54x |
| out.bam 500kb  | 21 | 383ms | 379ms | 365ms | 1.01x |

**Shared bandwidth** (round trips overlap, transfers queue for one 20MB/s pipe
— what 6 connections to one host, or one multiplexed HTTP/2 connection,
actually do):

| query | chunks | pool | waves(no stop) | waves+stop | pool+stop | barrier | net | MB |
| ----- | ------ | ---- | -------------- | ---------- | --------- | ------- | --- | -- |
| nanopore 100kb | 22 | 647ms | 745ms | 410ms | 406ms | 0.87x | **1.58x** | 9.3→6.0 |
| nanopore 20kb  | 22 | 648ms | 757ms | 407ms | 422ms | 0.86x | **1.59x** | 9.3→6.0 |
| out.bam 20kb   | 26 | 675ms | 821ms | 367ms | 368ms | 0.82x | **1.84x** | 9.5→5.6 |
| out.bam 500kb  | 21 | 718ms | 818ms | 479ms | 524ms | 0.88x | **1.50x** | 11.1→8.2 |
| out.bam whole  | 4  | 1024ms | 1032ms | 1019ms | 1029ms | 0.99x | 1.00x | — |
| nanopore 2Mb   | 3  | 792ms | 795ms | 800ms | 799ms | 1.00x | 0.99x | — |
| shortreads 2Mb | 2  | 374ms | 352ms | 361ms | 363ms | 1.06x | 1.04x | — |
| ultra-long whole | 2 | 400ms | 402ms | 397ms | 400ms | 1.00x | 1.01x | — |

### What it says

1. **When bandwidth is shared, the early stop is worth 1.50x-1.84x** on exactly
   the queries that are slow today, and is neutral (0.99x-1.04x) on every query
   that cannot stop. It is never a loss.
2. **When bandwidth is per-connection, it is a wash** (0.96x-1.54x, mostly
   ~1.0x). Cutting 22 requests to 6 only cuts bytes by ~35%, because the big
   chunks come first, and a latency-bound query with abundant bandwidth is not
   gated by bytes. Browsers share bandwidth, so the shared model is the one that
   describes the consumer that matters — but a bandwidth-rich client sees no
   gain rather than a loss.
3. **The barrier is not what limits it.** waves+stop and pool+stop are within
   noise of each other on every row (1.58 vs 1.59, 1.59 vs 1.53, 1.84 vs 1.84).
   The reason is now obvious: with the stop on, the query never runs a second
   wave, so the barrier is never reached.
4. The barrier's real cost, 1.14x-1.22x (0.82x-0.88x above), applies only to a
   query with more than 6 chunks and no stop available — which the survey found
   none of.

### One barrier, not one per wave

Barriering every wave leaves one residual risk: a query with more than 6 chunks
and no stop available pays 0.82x-0.88x. The survey found none, but a user's file
is not the corpus. Since the stop, when it exists, fired inside the *first*
batch on every fixture measured (`needed` was 1-3 everywhere), a query that
clears the first batch without stopping is one that needs its chunks — so it can
run the unbarriered pool for the rest. Measured against barriering every wave:

| query | chunks | waves | one barrier | waves worst case | one-barrier worst case |
| ----- | ------ | ----- | ----------- | ---------------- | ---------------------- |
| nanopore 100kb | 22 | 1.58x | **1.59x** | 0.87x | **0.93x** |
| nanopore 20kb  | 22 | 1.59x | **1.64x** | 0.86x | **0.94x** |
| out.bam 20kb   | 26 | 1.78x | **1.78x** | 0.82x | **0.92x** |
| out.bam 500kb  | 21 | 1.53x | **1.56x** | 0.88x | **0.95x** |
| the four ≤4-chunk queries | ≤4 | 0.99x-1.01x | 1.00x-1.02x | — | — |

Identical benefit, half the downside. "Worst case" is the same arm with the stop
forced off — what a >6-chunk query with no stop available would pay.

### Decision

Accepted as implemented: read the first `MAX_CONCURRENT_CHUNK_READS` chunks as
one batch, barrier, and stop if any of them is past the query; otherwise run the
existing pool over the remainder with no further barriers and no further stop
checks.

The barrier is what makes it deterministic — the batch is fixed by index, not by
which read finishes first — which is the property whose absence killed the first
attempt. `test/cache.test.ts` pins it directly: a repeated query must read no
more chunks the second time.

The earlier "Why not yet" reasoning was correct about the mechanism and wrong
about the magnitude. It assumed the barrier would be paid on the queries that
benefit; it is not, because those queries stop in the first batch.

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
