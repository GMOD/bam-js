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

Parity everywhere, and it widens rather than narrows on the big files — which is
where it matters, since those are the queries anyone notices. Every row was
checked to emit an identical number of callbacks, so none of it is a speedup
bought by reporting less.

The two windowed rows are the early stop, and its best case is better than
either of them: a 100kb viewport over ONT reads that all lie outside it walks
every CIGAR op of every read under jbrowse's version (12.9ms) and exits
immediately under this one (0.003ms), for the same — empty — output. That is one
pan step past a long read, which is not an exotic case.

## What adopting it costs jbrowse

Almost nothing, which was not obvious and is worth writing down. The emitted
vocabulary here is `@gmod/cram`'s, not jbrowse's, but the two differ in exactly
one thing a consumer can see:

- **The six type constants.** jbrowse's `MISMATCH_TYPE`…`HARDCLIP_TYPE` are 0-5;
  these are CIGAR char codes. Every use of them in jbrowse is an
  `if (type === X_TYPE)` chain in `collectMismatches`, `extractCigarFeatures`,
  `computeConsensus` and `csUtils` — never an array index, never serialized — so
  the values only have to change in the one file that declares them,
  `packages/cigar-utils/src/mismatchCallback.ts`, and no call site moves. 0-5
  was the worse choice for a BAM library anyway: it collides with BAM's own op
  numbering, where 0 is M and 2 is D, against 0 = mismatch and 2 = deletion.

The differences that look like they matter turn out to be invisible:

- **Deletion `bases`** is `''` here and `'*'` in jbrowse's walk — but every
  consumer drops it (`{type: 'deletion', start, length}`). Same for a skip's
  `'N'`.
- **A clip's `length`** is 0 here and 1 in jbrowse's walk — but
  `collectMismatches` sets `length: 1` itself and the render path reads
  `cliplen` and ignores `length`, which jbrowse's own comment says outright.
- **Positions** are absolute here and read-relative there — but `refStart` is a
  parameter, so passing 0 gives the read-relative behaviour at no cost.

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
