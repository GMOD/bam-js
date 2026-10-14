# ADR 0010 — Stopping a query once a chunk is past its range

Status: Accepted, implemented — one barrier after the first batch, then the
pool. See "The waves-vs-pool benchmark", which supersedes "Why not yet", and the
Amendment at the end, which revises the Decision for queries deeper than the
batch.

> **Since ADR 0023** `blocksForRange` drops, from the index alone, the chunks
> this stop used to find by reading one. Every fixture measured below now
> resolves to chunks the query needs, and chr22_nanopore's 10kb window to 1
> chunk rather than 22. The stop stays for files where the bins right of the
> query cannot bound it, such as jb2bench's 1000x.longread, and its tests now
> supply their own chunk list.

## Context

`getRecordsForRange` reads every chunk `blocksForRange` returns. On most files
that is right, because every chunk holds records the query wants. On long-read
files it is badly wrong, and the reason is the BAI linear index.

`getLowestChunk` returns `linearIndex[min >> 14]`, the smallest file offset of
any record overlapping that 16kb window, and `optimizeChunks` drops chunks
entirely below it. That lower bound is the only thing narrowing a query to its
region. One ultra-long read spanning a large region sets the bound near the
start of the file, and then the bound drops no chunks:

```
chr22_nanopore_subset.bam.bai   ref=21   1020 linear entries, 0 unset
  pos 16,000,000 -> linearIndex[976]  = 9603
  pos 16,400,000 -> linearIndex[1000] = 9603
```

The bound sits 9603 bytes into a 14MB file, so a narrow window reads every chunk
of every overlapping bin, at every level of the binning scheme:

| window | chunks | fetched | records returned |
| ------ | ------ | ------- | ---------------- |
| 10kb   | 22     | 9.3MB   | 0                |
| 100kb  | 22     | 9.3MB   | 0                |
| 400kb  | 9      | 11.9MB  | 35               |
| 1000kb | 3      | 13.6MB  | 757              |

A 10kb window costs 22 range requests and 66% of the file, and returns no
records. The 1Mb window is 100x larger and costs _three_ requests, because more
chunks bridge more gaps and `optimizeChunks` merges them.

htslib's BAI iterator has the same lower bound, so the bound is not a bam-js
bug. htslib also has **early termination**, which bam-js lacks: it walks chunks
in order and stops as soon as a record's position passes the query end, so it
never reads the later chunks. bam-js fetches all of a query's chunks up front
(ADR 0008), so it cannot stop.

## The available saving

Chunks come back from `optimizeChunks` sorted by `minv.blockPosition`, and a
coordinate-sorted BAM stores records in `(ref_id, start)` order. So chunk `i`'s
first record is at or before chunk `i+1`'s, and **a chunk whose first record is
already past the query has only past-the-query records behind it**.

`appendInRange` already depends on the coordinate-sorted order, and breaks out
of a chunk on exactly that assumption: "stop scanning once we pass `max` within
`chrId` or move past `chrId` entirely". Stopping at the chunk level applies the
same assumption one level up. A BAM that violates it already returned short
results.

The table counts the chunks a query would need if it stopped at the first chunk
whose first record starts at/after `max`. No case showed a non-monotonic chunk
order.

| file / window                          | chunks | fetched | needed | saving |
| -------------------------------------- | ------ | ------- | ------ | ------ |
| chr22_nanopore 10kb                    | 22     | 9.3MB   | 1      | ~95%   |
| chr22_nanopore 100kb                   | 22     | 9.3MB   | 1      | ~95%   |
| chr22_nanopore 400kb                   | 9      | 11.9MB  | 3      | 20%    |
| ultra-long-ont 400kb                   | 12     | 5.7MB   | 1      | ~90%   |
| ultra-long-ont 1000kb                  | 12     | 5.7MB   | 2      | 50%    |
| volvox 10kb                            | 3      | 0.3MB   | 2      | 43%    |
| shortreads_300x, out.bam, volvox 100kb | 1-2    | -       | all    | 0%     |

The saving appears on long reads in narrow windows, where the linear index
degenerates. Short-read files and wide windows save nothing, because they need
every chunk they were given.

## Why not yet

We implemented the stop as a `stopAfter` index shared by the worker pool in
`_fetchChunkFeatures`: a worker that finds `features[0]` past the query lowers
`stopAfter`, and workers stop claiming indices at or beyond it. Results were
correct, and all record-count assertions, including the ten pinned benchmark
regions, were unchanged.

**We backed it out because the stop index depends on worker scheduling.**
`test/cache.test.ts` caught it: running the identical query twice parsed 6
chunks and then 9. On a warm cache `_cachedChunkFeatures` resolves without I/O,
so workers claim indices far faster than any of them can set `stopAfter`. The
second query therefore does _more_ I/O than the first, and the cache grows on
repeat queries, which breaks the panning property that ADR 0001 protects.

The obvious fix is to process chunks in fixed waves of
`MAX_CONCURRENT_CHUNK_READS` and check the stop condition at each wave boundary.
Waves are deterministic, because the chunk index sets the wave boundaries, not
timing. But waves reintroduce a barrier: the slowest chunk in a wave delays the
next wave, and ADR 0008 measured that the work-stealing pool avoids exactly this
delay.

The decision is a trade between three options:

- **work-stealing pool** — best latency when every chunk is needed (the common
  case), but no deterministic early stop.
- **fixed waves** — deterministic early stop worth up to 95% of the I/O on
  long-read narrow windows, at the cost of a barrier on every query.
- **do nothing** — long-read narrow windows keep paying for the whole bin.

The choice needs a benchmark of waves-vs-pool on the files where _no_ early stop
is possible, since those files would pay for the change. That measurement has
not been done, and the 7.7.0 linear-index regression came from shipping a change
on intuition without one.

## The waves-vs-pool benchmark

The benchmark runs four schedulers against the real fixtures, asserts identical
record counts on every arm, and takes the min of 9 interleaved reps:

- **pool** — today's work-stealing loop, no early stop
- **waves** — fixed waves of 6 with a barrier, early stop _off_: isolates the
  cost of the barrier alone
- **waves+stop** — the proposal
- **pool+stop** — early stop without a barrier: the ceiling, if the determinism
  problem above were solved

### Which queries can stop

We surveyed every fixture for queries that produce more than one wave.

**Every query in the corpus with no early stop available has ≤ 4 chunks.**
`out.bam` whole (4), nanopore 2Mb (3), shortreads 2Mb (2), ultra-long whole (2).
Every query with more than 6 chunks has a stop available — 22, 22, 26, 21.

The chunk counts follow from `optimizeChunks`, which merges aggressively (65kb
gap, 5MB span). A query that needs a lot of data gets it in a few big chunks,
and a query with _many_ chunks is one whose bins are scattered, which is exactly
the case where most of them are past the query.

A barrier at 6-chunk boundaries therefore adds no measurable time to any no-stop
query in the corpus, and that changes the trade completely. With ≤ 4 chunks
there is only one wave, and one wave **is** the pool. We measured 0.99x-1.06x on
all four, as predicted.

### Measurements

We used two transport models, because the answer depends on which one you
believe, and between them they bracket it. In both, `bam.read` is delayed by a
50ms round trip plus transfer at 20MB/s.

**Per-connection bandwidth** (each concurrent read gets its own 20MB/s):

| query          | chunks | pool  | waves+stop | pool+stop | net   |
| -------------- | ------ | ----- | ---------- | --------- | ----- |
| nanopore 100kb | 22     | 363ms | 355ms      | 375ms     | 1.02x |
| nanopore 20kb  | 22     | 348ms | 361ms      | 341ms     | 0.96x |
| out.bam 20kb   | 26     | 388ms | 252ms      | 253ms     | 1.54x |
| out.bam 500kb  | 21     | 383ms | 379ms      | 365ms     | 1.01x |

**Shared bandwidth** (round trips overlap and transfers queue for one 20MB/s
pipe, which is how 6 connections to one host, or one multiplexed HTTP/2
connection, behave):

| query            | chunks | pool   | waves(no stop) | waves+stop | pool+stop | barrier | net       | MB       |
| ---------------- | ------ | ------ | -------------- | ---------- | --------- | ------- | --------- | -------- |
| nanopore 100kb   | 22     | 647ms  | 745ms          | 410ms      | 406ms     | 0.87x   | **1.58x** | 9.3→6.0  |
| nanopore 20kb    | 22     | 648ms  | 757ms          | 407ms      | 422ms     | 0.86x   | **1.59x** | 9.3→6.0  |
| out.bam 20kb     | 26     | 675ms  | 821ms          | 367ms      | 368ms     | 0.82x   | **1.84x** | 9.5→5.6  |
| out.bam 500kb    | 21     | 718ms  | 818ms          | 479ms      | 524ms     | 0.88x   | **1.50x** | 11.1→8.2 |
| out.bam whole    | 4      | 1024ms | 1032ms         | 1019ms     | 1029ms    | 0.99x   | 1.00x     | —        |
| nanopore 2Mb     | 3      | 792ms  | 795ms          | 800ms      | 799ms     | 1.00x   | 0.99x     | —        |
| shortreads 2Mb   | 2      | 374ms  | 352ms          | 361ms      | 363ms     | 1.06x   | 1.04x     | —        |
| ultra-long whole | 2      | 400ms  | 402ms          | 397ms      | 400ms     | 1.00x   | 1.01x     | —        |

### Findings

1. **When bandwidth is shared, the early stop is worth 1.50x-1.84x** on exactly
   the queries that are slow today, and is neutral (0.99x-1.04x) on every query
   that cannot stop, so it is never a loss.
2. **When bandwidth is per-connection, the stop makes little difference**
   (0.96x-1.54x, mostly ~1.0x). Cutting 22 requests to 6 cuts bytes by only
   ~35%, because the big chunks come first, and bytes do not limit a
   latency-bound query with abundant bandwidth. Browsers share bandwidth, so the
   shared model describes the consumer that matters, and a bandwidth-rich client
   sees no gain and no loss.
3. **The barrier does not limit the gain.** waves+stop and pool+stop are within
   noise of each other on every row (1.58 vs 1.59, 1.59 vs 1.53, 1.84 vs 1.84).
   With the stop on, the query never runs a second wave, so it never reaches the
   barrier.
4. The barrier's real cost, 1.14x-1.22x (0.82x-0.88x above), applies only to a
   query with more than 6 chunks and no stop available, and the survey found no
   such query.

### One barrier, not one per wave

With a barrier on every wave, a query with more than 6 chunks and no stop
available pays 0.82x-0.88x. The survey found none, but a user's file is not the
corpus. Since the stop, when it exists, fired inside the _first_ batch on every
fixture measured (`needed` was 1-3 everywhere), a query that clears the first
batch without stopping is one that needs its chunks, so it can run the pool with
no barrier for the rest. The table compares one barrier against a barrier on
every wave:

| query                     | chunks | waves       | one barrier | waves worst case | one-barrier worst case |
| ------------------------- | ------ | ----------- | ----------- | ---------------- | ---------------------- |
| nanopore 100kb            | 22     | 1.58x       | **1.59x**   | 0.87x            | **0.93x**              |
| nanopore 20kb             | 22     | 1.59x       | **1.64x**   | 0.86x            | **0.94x**              |
| out.bam 20kb              | 26     | 1.78x       | **1.78x**   | 0.82x            | **0.92x**              |
| out.bam 500kb             | 21     | 1.53x       | **1.56x**   | 0.88x            | **0.95x**              |
| the four ≤4-chunk queries | ≤4     | 0.99x-1.01x | 1.00x-1.02x | —                | —                      |

One barrier gives the same benefit with half the downside. "Worst case" is the
same arm with the stop forced off, which is what a >6-chunk query with no stop
available would pay.

### Decision

We accepted the design as implemented: read the first
`MAX_CONCURRENT_CHUNK_READS` chunks as one batch, barrier, and stop if any of
them is past the query; otherwise run the existing pool over the remainder with
no further barriers and no further stop checks.

The barrier makes the stop deterministic, because the batch is fixed by index,
not by which read finishes first. The first attempt failed for lack of that
property. `test/cache.test.ts` tests it directly: a repeated query must read no
more chunks the second time.

The earlier "Why not yet" reasoning was correct about the mechanism and wrong
about the magnitude. It assumed the barrier would be paid on the queries that
benefit; it is not, because those queries stop in the first batch.

## Amendment — the batch was also the stop's window, and deep coverage breaks that

Status: accepted, implemented. Revises "Decision" above: the pool now re-tests
the stop as each chunk finishes, not only after the first batch.

The decision above rests on one observation — "the stop, when it exists, fired
inside the _first_ batch on every fixture measured (`needed` was 1-3
everywhere)" — and therefore "a query that clears the first batch without
stopping is one that needs its chunks". That holds while a query's own data is
1-3 chunks. It fails when the data is more than `MAX_CONCURRENT_CHUNK_READS` of
them, because then nothing in the first batch _can_ be past the query.

GIAB's HG002 300x novoalign BAM (600GB, hs37d5), `1:10,000,000-10,100,000`:

| chunks | what they hold                                                      |
| ------ | ------------------------------------------------------------------- |
| 0-6    | 32,800-35,504 records each, all in range — 24.5MB, the query's data |
| 7-27   | 131-349 records each, **zero** in range — the BAI bin hierarchy     |

The query has seven chunks of data against a batch of six, so the stop never
fired, and the reader fetched all twenty-one tail chunks: 2.0MB and 21 round
trips that returned no records. The tail chunks' first records step by 2^14,
2^17, 2^20, 2^23, one chunk per bin level, each at the start of a successively
larger bin. `reg2bins` returns those bins at every level, and the linear index
cannot prune them because it bounds only from below.

Six paired runs against the stock reader returned identical records every time
and measured **28 requests -> 12, 26.8MB -> 25.3MB**, wall clock 6.68s -> 5.40s
mean (6.31 -> 5.50 median), prefix faster in four of six. The network link
varies by ±3s, so treat the request and byte counts as the result; the times
show only a consistent direction.

### What this costs

**The stop index stays deterministic; the overshoot does not.** Whether a chunk
is past the query is monotone in chunk index, because `optimizeChunks` returns
chunks sorted by `minv` and a sorted BAM's file order is its coordinate order.
The smallest index of a past chunk therefore depends on the chunk list alone,
whatever order reads finish in, and the pool never skips a chunk below it. The
number of chunks the workers had already taken when the stop was determined
varies with timing, and the pool width bounds it. Those chunks add no records to
the result.

Overshoot that varies with timing is weaker than what the barrier gave, and it
is the same axis the first attempt failed on. The first attempt could vary
_which records were returned_, and this one cannot. `test/cache.test.ts`'s "a
repeated query reads no more chunks the second time" still passes on this
corpus, but it is now a property of the corpus rather than a guarantee of the
algorithm.

### A completed-prefix check was tried first and does not work

A completed-prefix check examines chunk `i` only once every chunk before it has
finished. The check keeps the barrier's full determinism and was the obvious
answer, but it changes nothing here: chunk 6 is 3.5MB and slow, so while it is
in flight the other five workers consume all 21 tiny tail chunks, and the prefix
is blocked at exactly the boundary that would have stopped it. We measured 28
requests, unchanged.

### The fixture, and why it is synthetic

None of the real fixtures here has this structure, and building one is
impractical: the 5MB merge cap means seven chunks of query data is >30MB
compressed, a ~100MB file for one test. The test covers the scheduling, so
`bai.test.ts`'s "the stop fires past the first batch when a query is deeper than
it" supplies the chunk list and the records directly (7 head chunks inside the
query, 21 past it, the observed 300x proportions) and leaves
`_fetchChunkFeatures` real.

The test asserts that all 21 head records still come back, and that the number
of chunks read is between `HEAD` and `HEAD + MAX_CONCURRENT_CHUNK_READS`. That
upper bound is the overshoot as a number. The stop index is deterministic and
the reads past it are not, so the test pins the bound rather than an exact
count.

We checked the test against the old behaviour: reverting the pool to the
once-only check fails it with `expected 28 to be less than or equal to 13`.

## Notes for whoever picks this up

- The predicate must check `ref_id` as well as `start`, because `optimizeChunks`
  merges spans up to 5MB, so a merged chunk can span a reference boundary in the
  file.
  `first.ref_id > chrId || (first.ref_id === chrId && first.start >= max)`.
- An empty chunk has no record to give a position, so it must never stop the
  walk.
- `onProgress` reports against a total computed from all chunks, so an early
  stop needs a final `onProgress(totalBytes, totalBytes)` or a determinate bar
  never reaches its end.
- `featureLists` becomes sparse, so the append loop must skip holes.
- CSI is unaffected in principle but untested here. Until 2026-09-21,
  `getLowestChunk` returned 0:0 for CSI, so it never narrowed anything. CSI's
  `getLowestChunk` now takes the `loffset` of the finest bin at or left of the
  query start, as htslib does, and resolves to the same bytes as BAI on the
  volvox and CHM1 fixtures, so the same win should be available.
