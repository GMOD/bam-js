# ADR 0008 — Fetch a query's chunks concurrently

Status: Accepted

## Context

`_fetchChunkFeatures` walked the query's chunks in a `for` loop with an `await`
in the body, so chunk N+1's range request did not start until chunk N had been
downloaded, inflated and parsed.

A query spans many more chunks than the record counts suggest. On
`test/data/out.bam` (18.6 MB), nine 20kb windows averaged **14.8 chunks per
query** — `blocksForRange` returns one chunk per overlapping bin across all five
BAI levels, and `optimizeChunks` only merges those closer than 65kb.

For a local file that loop costs nothing much: the reads are page-cache hits and
the run time is decompression. For a *remote* file — the case jbrowse actually
ships — each iteration is a separate HTTP range request, so the query pays one
full network round trip per chunk, serially. With a 50 ms RTT injected into the
filehandle, a single 20kb query returning 70 records:

| | wall clock |
| ------------------------- | ---------- |
| sequential (14 reads) | 789 ms |
| latency floor (1 RTT) | ~50 ms |

Round-trip latency, not bandwidth and not decompression, was the dominant cost
of a remote query.

## Decision

Read the chunks with a bounded worker pool (`MAX_CONCURRENT_CHUNK_READS = 6`)
instead of one at a time. Results are collected into a per-chunk slot and
`appendInRange` is applied afterwards **in chunk order**, so the output does not
depend on completion order.

Six because that is the HTTP/1.1 per-host connection cap browsers enforce:
above it the extra requests queue in the browser anyway, while peak memory keeps
growing.

## Consequences / rationale

- **Remote queries get ~5x faster.** Same 50 ms-RTT benchmark: 789 → 162 ms.

- **Local queries are unaffected.** Interleaved A/B (both implementations in one
  process, alternating order, 15 iterations, on mains power — see the warning
  below): `out.bam` 43.8 → 41.5 ms, `shortreads_300x.bam` 40.7 → 40.2 ms,
  `chr22_nanopore_subset.bam` 83.4 → 83.5 ms at the min. Parity.

- **Output is byte-identical.** Base and new record sequences compared by
  `fileOffset:start:end:name` across every `.bam` in `test/data`, every ref, four
  coordinate windows and both `viewAsPairs` settings: **237,584 queries, 0
  mismatches**.

- **Ordering is a real invariant and is tested.** Chunk order is *not* coordinate
  order — bins at different levels cover overlapping spans, so the concatenation
  was never globally sorted, and a test asserting sortedness fails on `main`
  too. What must hold is that the result is the same sequence a sequential walk
  produced. `record order does not depend on which chunk finishes first` forces
  the inverse completion order with per-chunk delays and diffs the output;
  appending as chunks complete instead of in chunk order makes it fail.

- **Peak memory is barely affected in the common case.** Up to 6 chunks are
  inflated at once rather than 1, but any chunk contributing even one in-range
  record already had its whole buffer pinned by that record for the life of the
  query — so for a query whose chunks all contribute (the normal case) the
  buffers were all live anyway. The bound matters for the case where they don't.

- **`onProgress` still reports monotonically.** Workers add each chunk's
  `fetchedSize()` as it lands; the order varies but the running total only
  increases, so a determinate progress bar still behaves.

- **A failing chunk no longer stops the ones already in flight.** `Promise.all`
  rejects on the first error while sibling workers run to completion. They
  populate the cache and are discarded; the query still rejects.

## Benchmarking warning

The first A/B of this change showed a consistent **2x slowdown** on
`shortreads_300x` and `chr22_nanopore`, reproduced across separate processes at
15 iterations. It was entirely an artifact of the laptop running on battery:
CPU frequency scaling made the second process measured look slower regardless of
which implementation it ran. Reversing the order reversed the "regression", and
interleaving the two implementations within one process showed parity — as did
re-running everything on mains power.

An intermediate hypothesis — that concurrent `unzipChunkSlice` calls thrash the
shared wasm linear memory via `memory.grow` — was tested directly (decompress
the same pre-read buffers sequentially vs concurrently, no bam-js involved) and
**refuted**: concurrent was 0.79–1.04x, i.e. no worse.

For anything in this repo where the effect is under ~20%, measure both
implementations interleaved in a single process, alternating which goes first,
and check the power source.
