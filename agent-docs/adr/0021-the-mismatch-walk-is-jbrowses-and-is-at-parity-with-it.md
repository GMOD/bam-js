# ADR 0021 — The mismatch walk is jbrowse's, and had to land at parity with it

Status: Accepted

## Context

`src/mismatches.ts` is a port of jbrowse-components'
`packages/cigar-utils/src/forEachMismatchNumeric.ts`, which is the copy this is
meant to replace. That copy is on jbrowse's render path for every visible read
of every alignments track, so a port that is 10% slower is not a port anyone can
take: the whole point is that the walk moves here and jbrowse deletes its
version.

So "does it produce the same mismatches" was never the interesting question —
the tests answer that. The question was whether it costs the same.

## Decision

Keep the inner loops byte-for-byte equivalent to jbrowse's, and measure before
changing anything around them. Three changes were made; each is either free or
pays for itself:

- **Positions are absolute** (`refStart + roffset`), where jbrowse's are
  read-relative. One add per _reported_ difference, not per base. `refStart: 0`
  gives the read-relative behaviour back for a caller who wants it.
- **The window is clamped to int32** rather than left at the ±Infinity an
  unwindowed walk passes in, since every op compares an offset against it and
  Infinity makes each of those a Float64 comparison. BAM positions are int32, so
  no expressible window is narrowed.
- **The walk stops at the window's right edge** instead of running to the end of
  the CIGAR. This is the one real behavioural difference, and it is what makes a
  whole chromosome stored as one BAM read affordable to render a screenful of.

One thing that looked free and was not: computing the region-clamped comparison
bounds with `Math.max`/`Math.min` against ±Infinity. The result is a Float64,
`cmpHi` carries it into `jHi`, and `jHi` bounds the innermost two-bases-per-byte
loop — ~8% of the reference path on dense short reads, for two calls per record.
Ternaries keep it a Smi.

## Consequences / rationale

Measured on this machine against the vendored jbrowse implementation, **one arm
per process** (see below), min of 60 iterations per launch, min over 7
interleaved launches. Ratios are bam-js over jbrowse, so under 1.00 is faster:

| case                                       | jbrowse | bam-js  | ratio |
| ------------------------------------------ | ------- | ------- | ----- |
| volvox 100bp, MD (9,596 reads)             | 0.77ms  | 0.72ms  | 0.94  |
| shortreads_300x, no MD and no ref (53,596) | 5.25ms  | 5.07ms  | 0.97  |
| shortreads_300x, reference                 | 5.22ms  | 5.19ms  | 1.00  |
| volvox 100bp, reference                    | 2.48ms  | 2.34ms  | 0.94  |
| ecoli nanopore, reference (480 long reads) | 14.47ms | 14.53ms | 1.00  |
| volvox 100bp, MD, windowed to 1kb          | 0.70ms  | 0.51ms  | 0.73  |

Parity everywhere, and the windowed row is the early stop.

## Method notes

Three traps, all of which produced confident wrong numbers first:

- **Both arms in one process is unusable here.** Interleaved in-process arms put
  the reference path anywhere between 0.94x and 1.16x on consecutive runs of the
  same code. One arm per process, and the ratio settles to ±2%.
- **Absolute times drift ~35% across a session** as the machine warms, so only
  ratios from interleaved launches mean anything. A variant measured against a
  baseline taken ten minutes earlier is not measured at all.
- **Do not select the implementation through a lookup table.** Calling
  `variants[arm]!(...)` instead of a directly imported binding costs **4x** — V8
  stops inlining the callee — which swamps everything being measured. Each arm
  has to call its function by name.

## Known residual

The vendored copy of jbrowse's walk lives in a scratch directory, not in this
repo, so this table cannot be re-run from a clean checkout. It is a one-off
comparison against another project's file at a point in time; `benchmarks/` is
where the ongoing branch-to-branch numbers belong.
