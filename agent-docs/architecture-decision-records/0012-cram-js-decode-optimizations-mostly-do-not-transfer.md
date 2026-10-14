# ADR 0012 — Which cram-js decode optimizations transfer to BAM (mostly: none)

Status: Accepted (adopts three changes; rejects six ports, one of them twice;
partially supersedes ADR 0003 §1)

## Context

gmod/cram-js PR #173 landed a 21–31% short-read decode speedup as seven distinct
optimizations. The question was which of them are CRAM-specific and which apply
to this parser. We mapped each onto bam-js and measured it on the real fixtures.

The starting point is still ADR 0003: BGZF decompression is 70–90% of a cold
query, and everything here is a lazy accessor the consumer pays for only if it
touches it. We re-measured accessor cost, cold, min-of-5:

| fixture                   |  seq |  tags | CIGAR |  name |
| ------------------------- | ---: | ----: | ----: | ----: |
| shortreads_300x (53.6k)   | 51ms |  61ms |   5ms |  17ms |
| chr22_nanopore (757 long) | 16ms | 0.9ms |  68ms | 0.3ms |
| ultra-long-ont (75)       | 13ms | 0.2ms |  26ms |    0s |

The only two targets worth optimizing are `seq` (short reads) and `CIGAR` (long
reads).

## Ports that do not transfer (do not re-attempt)

1. **Bulk string decoding (one `TextDecoder` per slice).** CRAM's
   `byteArrayStop` codec lays read names end-to-end in one block, so the whole
   block is already a decoded string. BAM interleaves each name inside its own
   record; there is no contiguous run to decode. ADR 0003 §3 separately measured
   `TextDecoder` for `name` and it loses below ~40 chars anyway.

2. **Codec-owned fast paths / resolving tag type once per slice.** BAM has no
   codec layer and no per-slice binding site, and the parser reads the type byte
   from each tag inline. The nearest analogue is fusing `tagValueEnd` +
   `decodeTagValue` into one switch, measured at **1.05x** on 1.2M tags. That
   gain does not justify it: the two functions are deliberately separate, so
   that `_findTag` and `_computeTags` walk the tag layout with the same code and
   a change to the walk reaches both.

3. **Uint8Array table lookups instead of string keys.** This parser already uses
   them: `SEQRET_PAIR_CODES`, `ASCII_CIGAR_CODES`, `CIGAR_CONSUMES_REF_MASK`.

4. **O(1) terminator detection (`indexOf` instead of a NUL scan).** We measured
   it against the byte-scan loop in `tagValueEnd` at realistic Z-value lengths:

   | value length | scan loop  | `Uint8Array.indexOf` |
   | ------------ | ---------- | -------------------- |
   | 3            | **3.3ms**  | 7.8ms                |
   | 8            | **3.8ms**  | 10.0ms               |
   | 20           | **7.3ms**  | 9.4ms                |
   | 50           | **14.6ms** | 17.9ms               |
   | 200          | 60.3ms     | **36.1ms**           |

   `indexOf` only wins past ~100 bytes, and Z tags here are MD/RG/PG-sized, so
   the loop stays. (tabix-js's `parseNameBytes` does use `indexOf`, on different
   input with much longer runs.)

5. **Binary search over the index.** BAI/CSI already resolve bins by hash lookup
   rather than scanning. Iterating the _present_ bins instead of sweeping the
   requested bin range is 2.5x faster on a whole-chromosome query. We rejected
   it because that gain is 0.28ms → 0.11ms against a 100ms+ decompress, and the
   result inverts (much worse) for the small ranges that `fetchPairs` issues,
   one per mate.

We also measured and rejected two other changes while in the area:
`{__proto__: null}` instead of `Object.create(null)` for the tags object (1.03x
slower, because V8 does not fast-path it here), and a `Map` for tags (1.56x
faster, but a public API break).

## What was adopted

### `seq`: a 4-base table for the sub-threshold path (1.7–1.8x)

The concat path appended one 2-base string per SEQ byte. With a 65536-entry
table indexed by a _pair_ of bytes, the path makes half as many appends. We
measured end-to-end, min-of-41 over a fixed record set, with no I/O in the loop:

| fixture         | base   | after      |         |
| --------------- | ------ | ---------- | ------- |
| shortreads_300x | 30.2ms | **17.0ms** | 1.78x   |
| volvox-sorted   | 3.5ms  | **2.0ms**  | 1.72x   |
| chr22_nanopore  | 11.8ms | 11.8ms     | neutral |
| ultra-long-ont  | 5.7ms  | 5.8ms      | neutral |

The table costs ~6ms to fill and retains ~2MB, so it is built lazily **and**
behind a warmup counter. Building on first use was a 1.4x loss on long-read
files with a short-read tail (ecoli_nanopore: 27 sub-300bp reads of 480, chm1: 5
of 204), because those files paid the whole build to save microseconds. The
counter is module-global because the table is shared, so the build has to
amortize over the total short decodes in the process, not per file.

The >300bp `TextDecoder` path is untouched, and the 4-base table does not reach
it: at 1000bp the decoder is still 1.16x ahead, at 15000bp 1.68x.

### `CIGAR`: two appends per op instead of one (1.3–1.7x on long reads)

`result += length + String.fromCharCode(op)` builds an intermediate cons string
per op only to append and drop it. The new code appends each piece directly onto
the rope:

| fixture         | base   | after      |              |
| --------------- | ------ | ---------- | ------------ |
| chr22_nanopore  | 35.2ms | **25.1ms** | 1.40x        |
| ultra-long-ont  | 9.6ms  | **7.1ms**  | 1.35x        |
| ecoli_nanopore  | 6.3ms  | **3.7ms**  | 1.68x        |
| chm1            | 7.1ms  | **5.3ms**  | 1.33x        |
| shortreads_300x | 1.3ms  | 1.5ms      | 1.14x slower |
| volvox-sorted   | 0.39ms | **0.31ms** | 1.28x        |

**The CIGAR change partially supersedes ADR 0003 §1**, which rejected rewriting
this loop. That ADR tested a precomputed 16-entry op-char table and a
digits-into-a-Uint8Array-plus-TextDecoder rewrite. Both are still losers: the
op-char table re-measured 1.13x slower even on top of this change, because V8
already returns an interned single-character string from `fromCharCode`. ADR
0003 never tested a third approach, splitting the concat.

The two short-read rows disagree in direction (1.14x slower vs 1.28x faster) on
1-op CIGARs at sub-2ms magnitudes. That difference is this box's noise floor,
not a real regression: identical code measured anywhere from 0.97x to 1.20x
across runs. We built and measured a length-gated variant that kept the old form
for ≤8 ops. It was not reliably better than the unconditional form on any
fixture, so we dropped it for the simpler code. In absolute terms the trade is
+0.18ms on 53.6k short reads against −10ms on 757 nanopore reads.

## Who pays for these accessors — cross-referenced against jbrowse-components

We checked both wins against the real consumer afterwards, and the check changes
how to read them. Read this section before quoting the numbers above at anyone.

**jbrowse's default pileup render touches neither accessor.**
`BamSlightlyLazyFeature.forEachMismatch` drives everything off `NUMERIC_CIGAR`,
`NUMERIC_SEQ`, `NUMERIC_MD` and `qual`, and `extractFeatureArrays` deliberately
skips the CIGAR string for alignment features
(`isMismatch ? '' : feature.get('CIGAR')`, commented "avoiding a full per-read
CIGAR string build"). `packedCigarOps` likewise prefers `NUMERIC_CIGAR` and only
parses a string for adapters that lack it. A model of that whole per-record path
(`name`, start/end/flags/mapq, `template_length`, `pair_orientation`,
`getTag('SA')`, then the numeric accessors) measures **neutral on every
fixture**, as it should.

The string accessors cost time in modification/methylation rendering,
`perBaseLetter` color mode, soft-clip display, `modCoverage`, the feature-detail
panel and `toJSON`, and SAM export. They also cost time for direct bam-js
consumers, which is who these accessors are for.

**On the modification path the win is real but small**, because `seq` dominates
it and long reads take the (untouched, correct) `TextDecoder` branch.
`extractModifications` runs per record _unconditionally_, not gated on colorBy,
and builds both strings for any read with an MM tag. The table breaks the path
down by component on `arabidopsis_meth.bam` (154 reads, median 6145bp), the only
MM fixture with enough reads to measure:

| component      | base    | after       |                             |
| -------------- | ------- | ----------- | --------------------------- |
| `seq` string   | 2.440ms | 2.568ms     | ~60% of the path, untouched |
| `getTag('MM')` | 0.685ms | 0.703ms     | —                           |
| `CIGAR` string | 0.479ms | **0.365ms** | 1.31x                       |
| `getTag('ML')` | 0.378ms | 0.387ms     | —                           |

CIGAR is ~12% of that path, so 1.31x on it nets ~5% overall, which is what the
end-to-end number showed (1.06x).

**The bigger win there is on the jbrowse side, not here.**
`extractModifications` does `parseCigar2(feature.get('CIGAR'))`, and
`parseCigar2` emits `(length << 4) | opIndex` — byte-identical to
`NUMERIC_CIGAR`, as `parseCigar2Typed`'s own doc comment states. So bam-js
builds a string out of the packed CIGAR and jbrowse immediately parses it
straight back. If jbrowse switched those two call sites to the existing
`packedCigarOps()` helper, the round trip would disappear instead of getting
1.31x faster. That change belongs in a different repo and is not made here, but
on that path it is worth more than this ADR's CIGAR change.

## What the realistic corpus changed — measured on jb2bench

The fixtures in `test/data` are correctness fixtures, and sizing optimizations
against them is how the two conclusions below came out wrong the first time.
`~/src/jb2bench/data` has simulated 20x/200x/1000x short- and long-read BAMs
over one 250kb window, which is what jbrowse's own render benchmarks use.

**Accessors are a third of the heaviest query, not a few percent.** We replayed
exactly what `extractFeatureArrays` + `buildBaseFeatureData` + `forEachMismatch`
touch per record, on `1000x.shortread` (153677 records):

| stage                                                 | cost   | of query |
| ----------------------------------------------------- | ------ | -------- |
| `getRecordsForRange` (read + unzip + construct)       | 365ms  | —        |
| `buildBaseFeatureData` (`name` dominant)              | 69.6ms | 19.1%    |
| `getTagAlt('MM','Mm')`                                | 46.9ms | 12.9%    |
| `getTag('SA')`                                        | 35.8ms | 9.8%     |
| `forEachMismatch` inputs (NUMERIC_CIGAR/SEQ/MD, qual) | 32.2ms | 8.8%     |

`1000x.longread` is the opposite case: a 2725ms query with ~18ms of accessors
total (0.6%). Decompression dominates long-read queries but not short-read ones.

The second-biggest item is a tag that **is not there**. `extractModifications`
runs per record unconditionally, and `getTag(a) ?? getTag(b)` walks the whole
tag block twice to find that the tag is absent. We added `getTagAlt`, shown in
the table, for this case.

### Rejected on this corpus: `indexOf` for the Z/H scan (second look)

Item 4 above rejected `indexOf` on short-read Z lengths. On the long-read corpus
the distribution is **bimodal**, and the fixtures showed only one mode:

| corpus                  | Z values/rec | p50  | p90   | ≥32B  |
| ----------------------- | ------------ | ---- | ----- | ----- |
| jb2bench 200x.longread  | 2.0          | 4413 | 11045 | 50.0% |
| jb2bench 200x.shortread | 3.0          | 4    | 13    | 0.0%  |
| shortreads_300x         | 2.0          | 9    | 9     | 0.2%  |
| chr22_nanopore          | 2.1          | 11   | 24    | 5.5%  |

With long-read MD averaging 9083 bytes, we built and measured a hybrid that
probes 32 bytes inline and then calls `indexOf`. It was **2.67–2.70x** faster on
the MM/SA miss walks for 200x/1000x longread, and a stable **1.13x slower** on
shortreads_300x (three runs: 1.13/1.14/1.12, reproducible and above the noise
floor).

**We reverted it anyway**, because of how the corpus weights the two cases. The
long-read win is 23ms against a 2725ms query (0.8%), because decompression
dominates there. The short-read loss falls on a 365ms query where tag walking
really is ~23%. Making the dominant case worse to speed up a case that is 99.4%
decompression is the wrong trade. Don't re-attempt without a long-read profile
where the query is not decompression-bound.

### Adopted on this corpus: `getTagAlt`, one walk instead of two

`getTagAlt` resolves an alias pair in a single pass, replacing
`getTag(a) ?? getTag(b)`:

| corpus          | two walks | one walk    |       |
| --------------- | --------- | ----------- | ----- |
| 1000x.longread  | 26.41ms   | **12.17ms** | 2.17x |
| 200x.shortread  | 6.80ms    | **4.54ms**  | 1.50x |
| 1000x.shortread | 37.07ms   | **24.89ms** | 1.49x |
| shortreads_300x | 8.25ms    | **5.66ms**  | 1.46x |
| volvox-sorted   | 1.25ms    | **0.86ms**  | 1.46x |

`getTagAlt` is faster on **every** case, where the `indexOf` hybrid traded one
case against another. jbrowse's `modifications-utils` `getTagAlt()` duck-types
it, the same way it already duck-types `getTag`, and `RegionBoundBamFeature`
must delegate it, or MD-less reads fall back to the two-walk form with no error
to show it.

When benchmarking any of this, note that **the `tags` getter populates
`_cachedTags`, after which `getTag` reads the cache instead of walking.** If a
harness touches `.tags` anywhere, including in a correctness pass before the
timed one, every later `getTag` looks ~free, and the harness understates the
walk by 100x. jbrowse's pileup path does not touch `.tags`, so production pays
for the walk.

## Verification

We compared `seq` and `CIGAR` byte-for-byte against the pre-change build over
**74181 records across all 24 indexed fixtures**, with zero mismatches. We
compared `getTagAlt` against `getTag(a) ?? getTag(b)` over every record of the
jb2bench corpus plus the fixtures, also with zero mismatches. Unit tests pin
`getTagAlt`, covering both orderings when a record has both names.

The 4-base table sits behind a warmup counter, so without a dedicated test the
suite would never execute it. `record.test.ts` has a test that crosses the
warmup and re-runs every seq case, and we mutation-checked it: breaking the
leftover-pair branch makes it fail.

## Methodology note

The conditions ADR 0003 warned about have got worse: this box idles at load
average ~20 on 16 cores. When we timed an accessor by re-querying between
passes, decompression noise swamped deltas under ~20%, and the same fixture
flipped direction between runs. The method that worked fetches the record set
once per build, then alternates timed passes over the same arrays and reports
the minimum of 41. Neither `seq` nor the CIGAR string build is memoized, so a
repeated pass redoes exactly the work under test with no I/O in the loop.
Anything under ~1.2x on a sub-2ms case is still noise.
