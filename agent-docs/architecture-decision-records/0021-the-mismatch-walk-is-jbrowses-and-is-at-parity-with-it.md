# ADR 0021 — The mismatch walk is jbrowse's, and had to reach parity with it

Status: Accepted

## Context

`src/mismatches.ts` is a port of jbrowse-components'
`packages/cigar-utils/src/forEachMismatchNumeric.ts`, and is meant to replace
that file. The plan is for the walk to move here and for jbrowse to delete its
version. jbrowse runs that walk on its render path for every visible read of
every alignments track, so it could not adopt a port that was 10% slower.

The tests check that the port produces the same mismatches. The open question
was whether it costs the same.

## Decision

Keep the inner loops byte-for-byte equivalent to jbrowse's, and measure before
changing anything around them. We made three changes, and each either costs
nothing or saves more than it costs:

- **Positions are absolute** (`refStart + roffset`), where jbrowse's are
  read-relative. The change costs one add per _reported_ difference, not per
  base. `refStart: 0` gives the read-relative behaviour back for a caller who
  wants it.
- **The window is clamped to int32** rather than left at the ±Infinity an
  unwindowed walk passes in, since every op compares an offset against it and
  Infinity makes each of those a Float64 comparison. BAM positions are int32, so
  no expressible window is narrowed.
- **The walk stops at the window's right edge** instead of running to the end of
  the CIGAR. This is the one real behavioural difference, and it makes a
  screenful of a whole chromosome stored as one BAM read affordable to render.

Computing the region-clamped comparison bounds with `Math.max`/`Math.min`
against ±Infinity looked free and was not. The result is a Float64, `cmpHi`
passes it into `jHi`, and `jHi` bounds the innermost two-bases-per-byte loop, so
the two calls per record cost ~8% of the reference path on dense short reads.
The code uses ternaries instead, which keep the bound a Smi.

## Consequences / rationale

We measured on this machine against the vendored jbrowse implementation, with
**one arm per process** (see below), taking the min of 60 iterations per launch
and the min over 7 interleaved launches. Ratios are bam-js over jbrowse, so
under 1.00 is faster:

| case                                        | jbrowse  | bam-js   | ratio |
| ------------------------------------------- | -------- | -------- | ----- |
| volvox 100bp, MD (9,596 reads)              | 0.77ms   | 0.72ms   | 0.94  |
| shortreads_300x, no MD and no ref (53,596)  | 5.25ms   | 5.07ms   | 0.97  |
| shortreads_300x, reference                  | 5.22ms   | 5.19ms   | 1.00  |
| volvox 100bp, reference                     | 2.48ms   | 2.34ms   | 0.94  |
| ecoli nanopore, reference (480 long reads)  | 14.47ms  | 14.53ms  | 1.00  |
| chr22 nanopore, no MD and no ref (757)      | 15.61ms  | 15.08ms  | 0.97  |
| chr22 nanopore, reference (8.7M mismatches) | 108.11ms | 101.30ms | 0.94  |
| ultra-long ONT, reference (75 reads, 2Mb)   | 61.60ms  | 59.95ms  | 0.97  |
| ultra-long ONT, 100kb viewport              | 40.24ms  | 36.70ms  | 0.91  |
| volvox 100bp, MD, windowed to 1kb           | 0.70ms   | 0.51ms   | 0.73  |

The ratio is at or under 1.00 in every row, and the gap widens rather than
narrows on the big files, whose queries are the ones users notice. We checked
that every row emits an identical number of callbacks, so no row is faster
because it reports less.

The two windowed rows measure the early stop, and its best case beats both of
them. With a 100kb viewport over ONT reads that all lie outside it, jbrowse's
version walks every CIGAR op of every read (12.9ms) and this one exits
immediately (0.003ms), for the same empty output. One pan step past a long read
produces that case, so it is common.

## Adopting the walk changes only jbrowse's type constants

Adopting the walk costs jbrowse almost nothing, which was not obvious. The walk
emits `@gmod/cram`'s vocabulary, not jbrowse's, but the two vocabularies differ
in exactly one thing a consumer can see:

- **The six type constants.** jbrowse's `MISMATCH_TYPE`…`HARDCLIP_TYPE` are 0-5;
  these are CIGAR char codes. Every use of them in jbrowse is an
  `if (type === X_TYPE)` chain in `collectMismatches`, `extractCigarFeatures`,
  `computeConsensus` and `csUtils`; jbrowse never uses them as an array index or
  serializes them. The values therefore only have to change in the one file that
  declares them, `packages/cigar-utils/src/mismatchCallback.ts`, and no call
  site moves. 0-5 was the worse choice for a BAM library anyway, because it
  collides with BAM's own op numbering, where 0 is M and 2 is D, against 0 =
  mismatch and 2 = deletion.

The differences that look like they matter turn out to be invisible:

- **Deletion `bases`** is `''` here and `'*'` in jbrowse's walk, but every
  consumer drops it (`{type: 'deletion', start, length}`). The same holds for a
  skip's `'N'`.
- **A clip's `length`** is 0 here and 1 in jbrowse's walk, but
  `collectMismatches` sets `length: 1` itself and the render path reads
  `cliplen` and ignores `length`, as jbrowse's own comment says outright.
- **Positions** are absolute here and read-relative there, but `refStart` is a
  parameter, so passing 0 gives the read-relative behaviour at no cost.

## Method notes

Three measurement mistakes each gave us confident wrong numbers first:

- **Both arms in one process is unusable here.** Interleaved in-process arms put
  the reference path anywhere between 0.94x and 1.16x on consecutive runs of the
  same code. With one arm per process, the ratio settles to ±2%.
- **Absolute times change by ~35% across a session** as the machine warms, so
  only ratios from interleaved launches mean anything. A variant compared
  against a baseline taken ten minutes earlier gives a meaningless ratio.
- **Do not select the implementation through a lookup table.** Calling
  `variants[arm]!(...)` instead of a directly imported binding costs **4x**,
  because V8 stops inlining the callee, and that swamps everything being
  measured. Each arm has to call its function by name.

## Known residual

The vendored copy of jbrowse's walk is in a scratch directory, not in this repo,
so this table cannot be re-run from a clean checkout. It is a one-off comparison
against another project's file at a point in time. The ongoing branch-to-branch
numbers belong in `benchmarks/`.
