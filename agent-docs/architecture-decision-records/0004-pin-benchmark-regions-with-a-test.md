# ADR 0004 — Pin every benchmark region with a record-count test

Status: Accepted

## Context

`benchmarks/bam.bench.ts` queried reference names that seven of its ten files do
not contain:

| benchmark                      | queried     | file actually has |
| ------------------------------ | ----------- | ----------------- |
| tiny.bam                       | `ctgA`      | `22`              |
| paired.bam                     | `ctgA`      | `20`              |
| cho.bam                        | `chr10`     | `chr1_scaffold_0` |
| ecoli_nanopore.bam             | `ref000001` | `ref000001\|chr`  |
| another_chm1_id_difference.bam | `chr20`     | `chr1`            |
| shortreads_300x.bam            | `ctgA`      | `1`               |
| chr22_nanopore_subset.bam      | `chr22`     | `22`              |

`getRecordsForRange` resolves an unknown name to `undefined` via `chrToIndex`
and returns `[]` before touching the index, BGZF, or record code. So those seven
benchmarks ran clean, reported plausible-looking numbers, and measured nothing
but `getHeader()`. The three biggest files, which hold the long-read and
high-depth cases the suite was written to measure, were among them.

A benchmark has no assertions, and an empty result looks the same as a fast one,
so no check in the codebase could catch the wrong names.

## Decision

Fix the regions, and add `test/benchmark-regions.test.ts` asserting the exact
record count each benchmark region yields. The region list is duplicated between
the benchmark and the test on purpose, so a region that falls out of date fails
CI instead of passing unnoticed.

## Consequences / rationale

- A future rename, refixture, or copy-paste of a region into the wrong file
  fails `pnpm test` with a concrete count mismatch.
- We chose the regions to bracket where each file's records are (found via
  `indexCov` and per-ref `lineCount`) rather than to span the whole contig,
  because a whole-contig query on a subset file spends most of its time on empty
  bins.
- The counts are exact rather than `toBeGreaterThan(0)`. A count that changes
  should be a deliberate edit, since it means the benchmark's workload changed
  and prior numbers are no longer comparable.
- Benchmarks stay cold queries (`new BamFile` per iteration). The warm and
  panning paths that ADR 0001 targets are guarded by assertions in
  `test/cache.test.ts` instead, since a cache-reuse regression shows up as a
  cache-identity failure far more reliably than as a wall-clock delta.
