# ADR 0008 — Fetch a query's chunks concurrently

Status: Accepted

## Context

`_fetchChunkFeatures` walked the query's chunks in a `for` loop with an `await`
in the body, so chunk N+1's range request did not start until chunk N had been
downloaded, inflated and parsed.

A query spans many more chunks than the record counts suggest. On
`test/data/out.bam` (18.6 MB), nine 20kb windows averaged **14.8 chunks per
query**, because `blocksForRange` returns one chunk per overlapping bin across
all five BAI levels, and `optimizeChunks` only merges those closer than 65kb.

For a local file the loop adds little, because the reads are page-cache hits and
the run time is decompression. For a _remote_ file — the case jbrowse actually
ships — each iteration is a separate HTTP range request, so the query pays one
full network round trip per chunk, serially. With a 50 ms RTT injected into the
filehandle, a single 20kb query returning 70 records:

|                       | wall clock |
| --------------------- | ---------- |
| sequential (14 reads) | 789 ms     |
| latency floor (1 RTT) | ~50 ms     |

Round-trip latency, not bandwidth and not decompression, was the dominant cost
of a remote query.

## Decision

Read the chunks with a bounded worker pool (`MAX_CONCURRENT_CHUNK_READS = 6`)
instead of one at a time. Results are collected into a per-chunk slot and
`appendInRange` is applied afterwards **in chunk order**, so the output does not
depend on completion order.

The pool size is six because browsers enforce a cap of six HTTP/1.1 connections
per host. Above it the extra requests queue in the browser anyway, while peak
memory keeps growing.

## Consequences / rationale

- **Remote queries get ~4x faster, and it composes with jbrowse's fetch layer.**
  A bare 50 ms-RTT filehandle gives 789 → 162 ms, but that overstates the win:
  jbrowse does not read through a bare filehandle. `RemoteFileWithRangeCache`
  (`packages/core/src/util/io`) sits underneath and already does 256 KB
  chunk-aligned caching, coalescing of contiguous missing chunks into one range
  request, and byte-level in-flight de-duplication with its own
  `MAX_CONCURRENT = 20`.

  We re-measured through a faithful model of that layer, 50 ms per request:

  | file                  | HTTP requests | bytes   | sequential | concurrent |
  | --------------------- | ------------- | ------- | ---------- | ---------- |
  | out.bam (14 chunks)   | 13 both       | 8.7 MB  | 734 ms     | **192 ms** |
  | chr22_nanopore_subset | 3 both        | 14.2 MB | 277 ms     | **185 ms** |
  | shortreads_300x       | 2 both        | 5.0 MB  | 194 ms     | **143 ms** |

  The request count and byte count are **identical** in both columns, so the
  concurrency cuts latency without adding bandwidth or request amplification,
  and the two layers work together. When several of our concurrent chunk reads
  fall inside the same 256 KB block, the byte-level dedup in the layer below
  merges them into one fetch.

  `RemoteFileWithRangeCache` dedups _bytes_ but not _decompression_, so it does
  nothing for duplicate inflates. ADR 0007's dedup is therefore still needed
  alongside it.

- **Local single-query performance is unchanged, as designed.**
  `benchmarks/bam.bench.ts` issues one sequential query against a local file,
  the one workload that neither this change nor ADR 0007 targets, because it has
  no round trips to hide and no concurrent queries to share. Parity is the
  expected result.

  An interleaved A/B (both implementations in one process, alternating order, 15
  iterations) confirms it, with `out.bam` 43.8 → 41.5 ms, `shortreads_300x` 40.7
  → 40.2 ms and `chr22_nanopore_subset` 83.4 → 83.5 ms at the min.

- **A one-chunk query skips the pool.** The pool allocates a result slot per
  chunk, a closure, a worker array and a `Promise.all`; for one chunk that is
  pure overhead, and it showed up on queries taking ~0.2 ms. `tiny.bam`
  regressed ~7% before the fast path was added. Single-chunk queries are common:
  every small test file produces them, and so does any query that falls inside
  one bin.

- **Output is byte-identical.** We compared base and new record sequences by
  `fileOffset:start:end:name` across every `.bam` in `test/data`, every ref,
  four coordinate windows and both `viewAsPairs` settings: **237,584 queries, 0
  mismatches**.

- **Ordering is a real invariant and is tested.** Chunk order is _not_
  coordinate order. Bins at different levels cover overlapping spans, so the
  concatenation was never globally sorted, and a test asserting sortedness fails
  on `main` too. The result must be the same sequence a sequential walk
  produced. `record order does not depend on which chunk finishes first` forces
  the inverse completion order with per-chunk delays and diffs the output;
  appending as chunks complete instead of in chunk order makes it fail.

- **Peak memory is barely affected in the common case.** Up to 6 chunks are
  inflated at once rather than 1, but any chunk contributing even one in-range
  record already had its whole buffer pinned by that record for the life of the
  query. For a query whose chunks all contribute (the normal case), the buffers
  were therefore all live anyway. The bound matters for the case where they
  don't.

- **`onProgress` still reports monotonically.** Workers add each chunk's
  `fetchedSize()` as it finishes; the order varies but the running total only
  increases, so a determinate progress bar still behaves.

- **A failing chunk no longer stops the ones already in flight.** `Promise.all`
  rejects on the first error while sibling workers run to completion. They
  populate the cache and are discarded; the query still rejects.

## Benchmarking warning

The first A/B of this change showed a consistent **2x slowdown** on
`shortreads_300x` and `chr22_nanopore`, reproduced across separate processes at
15 iterations. The slowdown came entirely from the laptop running on battery.
CPU frequency scaling made the second process measured look slower regardless of
which implementation it ran. Reversing the order reversed the "regression", and
interleaving the two implementations within one process showed parity, as did
re-running everything on mains power.

We also tested directly the intermediate hypothesis that concurrent
`unzipChunkSlice` calls thrash the shared wasm linear memory via `memory.grow`.
Decompressing the same pre-read buffers sequentially and concurrently, with no
bam-js involved, **refuted** it, since concurrent was 0.79–1.04x, i.e. no worse.

**`pnpm bench` has the same weakness.** tinybench runs all of variant A's
iterations, then all of B's, without interleaving per iteration, so it has
exactly this bias. In the full suite run in both slot orders, every result
flipped sign except `tiny.bam` (1.08x / 1.07x, consistently slower, which is the
real single-chunk regression) and `volvox-sorted` (1.01x / 1.06x, same
direction). The apparent 1.22x regression on `cho.bam` and the apparent 1.80x
win on `another_chm1_id_difference` both reversed and were artifacts.

For any effect in this repo under ~20%, run the suite in both slot orders and
discard anything that flips, or measure the variants rotated within a single
process. Also check the power source.
