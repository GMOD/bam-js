# ADR 0012 — Which cram-js decode optimizations transfer to BAM (mostly: none)

Status: Accepted (adopts three changes; rejects six ports, one of them twice;
partially supersedes ADR 0003 §1)

## Context

gmod/cram-js PR #173 landed a 21–31% short-read decode speedup as seven distinct
optimizations. The question was which of them are CRAM-specific and which apply
to this parser. Each was mapped onto bam-js and measured on the real fixtures.

The starting point is still ADR 0003: BGZF decompression is 70–90% of a cold
query, and everything here is a lazy accessor the consumer pays for only if it
touches it. Re-measured accessor cost, cold, min-of-5:

| fixture                   |  seq |  tags | CIGAR |  name |
| ------------------------- | ---: | ----: | ----: | ----: |
| shortreads_300x (53.6k)   | 51ms |  61ms |   5ms |  17ms |
| chr22_nanopore (757 long) | 16ms | 0.9ms |  68ms | 0.3ms |
| ultra-long-ont (75)       | 13ms | 0.2ms |  26ms |    0s |

So the only two targets worth anything are `seq` (short reads) and `CIGAR` (long
reads).

## Ports that do NOT transfer — do not re-attempt

1. **Bulk string decoding (one `TextDecoder` per slice).** CRAM's
   `byteArrayStop` codec lays read names end-to-end in one block, so the whole
   block is already a decoded string. BAM interleaves each name inside its own
   record; there is no contiguous run to decode. ADR 0003 §3 separately measured
   `TextDecoder` for `name` and it loses below ~40 chars anyway.

2. **Codec-owned fast paths / resolving tag type once per slice.** BAM has no
   codec layer and no per-slice binding site — the type byte is read from each
   tag inline. The nearest analogue is fusing `tagValueEnd` + `decodeTagValue`
   into one switch, measured at **1.05x** on 1.2M tags. Not worth it: the two
   are deliberately separate so `_findTag` and `_computeTags` cannot drift in
   how they walk the tag layout.

3. **Uint8Array table lookups instead of string keys.** Already how this parser
   works — `SEQRET_PAIR_CODES`, `ASCII_CIGAR_CODES`, `CIGAR_CONSUMES_REF_MASK`.

4. **O(1) terminator detection (`indexOf` instead of a NUL scan).** Measured
   against the byte-scan loop in `tagValueEnd` at realistic Z-value lengths:

   | value length | scan loop  | `Uint8Array.indexOf` |
   | ------------ | ---------- | -------------------- |
   | 3            | **3.3ms**  | 7.8ms                |
   | 8            | **3.8ms**  | 10.0ms               |
   | 20           | **7.3ms**  | 9.4ms                |
   | 50           | **14.6ms** | 17.9ms               |
   | 200          | 60.3ms     | **36.1ms**           |

   `indexOf` only wins past ~100 bytes, and Z tags here are MD/RG/PG-sized. The
   loop stays. (Note tabix-js's `parseNameBytes` does use `indexOf` — different
   input, much longer runs.)

5. **Binary search over the index.** BAI/CSI already resolve bins by hash lookup
   rather than scanning. Iterating the _present_ bins instead of sweeping the
   requested bin range is 2.5x on a whole-chromosome query — but that is 0.28ms
   → 0.11ms against a 100ms+ decompress, and it inverts (much worse) for the
   small ranges `fetchPairs` issues one per mate. Rejected.

Also measured and rejected while in the area: `{__proto__: null}` instead of
`Object.create(null)` for the tags object (1.03x SLOWER — V8 does not fast-path
it here), and a `Map` for tags (1.56x faster, but it is a public API break).

## What was adopted

### `seq`: a 4-base table for the sub-threshold path (1.7–1.8x)

The concat path appended one 2-base string per SEQ byte. Indexing a 65536-entry
table by a _pair_ of bytes halves the appends. Measured end-to-end, min-of-41
over a fixed record set (no I/O in the loop):

| fixture         | base   | after      |         |
| --------------- | ------ | ---------- | ------- |
| shortreads_300x | 30.2ms | **17.0ms** | 1.78x   |
| volvox-sorted   | 3.5ms  | **2.0ms**  | 1.72x   |
| chr22_nanopore  | 11.8ms | 11.8ms     | neutral |
| ultra-long-ont  | 5.7ms  | 5.8ms      | neutral |

The table costs ~6ms to fill and retains ~2MB, so it is built lazily **and**
behind a warmup counter. Building on first use was a 1.4x LOSS on long-read
files with a short-read tail (ecoli_nanopore: 27 sub-300bp reads of 480, chm1: 5
of 204) — they paid the whole build to save microseconds. The counter is
module-global because the table is shared; what must amortize is total short
decodes in the process, not per file.

The >300bp `TextDecoder` path is untouched, and the 4-base table does not reach
it: at 1000bp the decoder is still 1.16x ahead, at 15000bp 1.68x.

### `CIGAR`: two appends per op instead of one (1.3–1.7x on long reads)

`result += length + String.fromCharCode(op)` builds an intermediate cons string
per op only to append and drop it. Appending each piece directly onto the rope:

| fixture         | base   | after      |              |
| --------------- | ------ | ---------- | ------------ |
| chr22_nanopore  | 35.2ms | **25.1ms** | 1.40x        |
| ultra-long-ont  | 9.6ms  | **7.1ms**  | 1.35x        |
| ecoli_nanopore  | 6.3ms  | **3.7ms**  | 1.68x        |
| chm1            | 7.1ms  | **5.3ms**  | 1.33x        |
| shortreads_300x | 1.3ms  | 1.5ms      | 1.14x slower |
| volvox-sorted   | 0.39ms | **0.31ms** | 1.28x        |

**This partially supersedes ADR 0003 §1**, which rejected rewriting this loop.
That ADR tested a precomputed 16-entry op-char table and a
digits-into-a-Uint8Array-plus-TextDecoder rewrite. Both are still losers — the
op-char table re-measured 1.13x SLOWER even on top of this change, because V8
already returns an interned single-character string from `fromCharCode`.
Splitting the concat is a third thing, and it was never tested there.

The two short-read rows disagree in direction (1.14x slower vs 1.28x faster) on
1-op CIGARs at sub-2ms magnitudes — that is this box's noise floor, not a real
regression; identical code measured anywhere from 0.97x to 1.20x across runs. A
length-gated variant that kept the old form for ≤8 ops was built and measured,
and was not reliably better than the unconditional form on any fixture, so it
was dropped for the simpler code. In absolute terms the trade is +0.18ms on
53.6k short reads against −10ms on 757 nanopore reads.

## Who actually pays this — cross-referenced against jbrowse-components

Checked against the real consumer afterwards, and it reframes both wins. Be
honest about this before quoting the numbers above at anyone.

**jbrowse's default pileup render touches neither accessor.**
`BamSlightlyLazyFeature.forEachMismatch` drives everything off `NUMERIC_CIGAR`,
`NUMERIC_SEQ`, `NUMERIC_MD` and `qual`, and `extractFeatureArrays` deliberately
skips the CIGAR string for alignment features
(`isMismatch ? '' : feature.get('CIGAR')`, commented "avoiding a full per-read
CIGAR string build"). `packedCigarOps` likewise prefers `NUMERIC_CIGAR` and only
parses a string for adapters that lack it. Modelling that whole per-record path
— `name`, start/end/flags/mapq, `template_length`, `pair_orientation`,
`getTag('SA')`, then the numeric accessors — measures **neutral on every
fixture**, as it should.

So the string accessors are paid by: modification/methylation rendering,
`perBaseLetter` color mode, soft-clip display, `modCoverage`, the feature-detail
panel and `toJSON`, SAM export — and by direct bam-js consumers, which is who
these accessors are really for.

**On the modification path the win is real but small**, because `seq` dominates
it and long reads take the (untouched, correct) `TextDecoder` branch.
`extractModifications` runs per record _unconditionally_ — not gated on colorBy
— and builds both strings for any read carrying MM. Component breakdown on
`arabidopsis_meth.bam` (154 reads, median 6145bp), the only MM fixture with
enough reads to measure:

| component      | base    | after       |                             |
| -------------- | ------- | ----------- | --------------------------- |
| `seq` string   | 2.440ms | 2.568ms     | ~60% of the path, untouched |
| `getTag('MM')` | 0.685ms | 0.703ms     | —                           |
| `CIGAR` string | 0.479ms | **0.365ms** | 1.31x                       |
| `getTag('ML')` | 0.378ms | 0.387ms     | —                           |

CIGAR is ~12% of that path, so 1.31x on it nets ~5% overall — which is what the
end-to-end number showed (1.06x).

**The bigger win there is on the jbrowse side, not here.**
`extractModifications` does `parseCigar2(feature.get('CIGAR'))`, and
`parseCigar2` emits `(length << 4) | opIndex` — byte-identical to
`NUMERIC_CIGAR`, as `parseCigar2Typed`'s own doc comment states. So bam-js
builds a string out of the packed CIGAR and jbrowse immediately parses it
straight back. Switching those two call sites to the existing `packedCigarOps()`
helper deletes the round trip entirely rather than making it 1.31x faster. Not
done here — different repo — but it is worth more than this ADR's CIGAR change
on that path.

## What the realistic corpus changed — measured on jb2bench

The fixtures in `test/data` are correctness fixtures, and sizing optimizations
against them is how the two conclusions below came out wrong the first time.
`~/src/jb2bench/data` has simulated 20x/200x/1000x short- and long-read BAMs
over one 250kb window, which is what jbrowse's own render benchmarks use.

**Accessors are a third of the heaviest query, not a few percent.** Replaying
exactly what `extractFeatureArrays` + `buildBaseFeatureData` + `forEachMismatch`
touch per record, on `1000x.shortread` (153677 records):

| stage                                                 | cost   | of query |
| ----------------------------------------------------- | ------ | -------- |
| `getRecordsForRange` (read + unzip + construct)       | 365ms  | —        |
| `buildBaseFeatureData` (`name` dominant)              | 69.6ms | 19.1%    |
| `getTagAlt('MM','Mm')`                                | 46.9ms | 12.9%    |
| `getTag('SA')`                                        | 35.8ms | 9.8%     |
| `forEachMismatch` inputs (NUMERIC_CIGAR/SEQ/MD, qual) | 32.2ms | 8.8%     |

`1000x.longread` is the opposite shape: a 2725ms query with ~18ms of accessors
total (0.6%). Long-read is a decompression story; short-read is not.

The second-biggest item is a tag that **is not there** — `extractModifications`
runs per record unconditionally, and `getTag(a) ?? getTag(b)` walks the whole
tag block twice to prove it. Hence `getTagAlt` above.

### Rejected on this corpus: `indexOf` for the Z/H scan (second look)

Item 4 above rejected `indexOf` on short-read Z lengths. The long-read corpus
says the distribution is **bimodal**, and the fixtures only showed one mode:

| corpus                  | Z values/rec | p50  | p90   | ≥32B  |
| ----------------------- | ------------ | ---- | ----- | ----- |
| jb2bench 200x.longread  | 2.0          | 4413 | 11045 | 50.0% |
| jb2bench 200x.shortread | 3.0          | 4    | 13    | 0.0%  |
| shortreads_300x         | 2.0          | 9    | 9     | 0.2%  |
| chr22_nanopore          | 2.1          | 11   | 24    | 5.5%  |

Long-read MD averages 9083 bytes. A "probe 32 bytes inline, then `indexOf`"
hybrid was built and measured: **2.67–2.70x** faster on the MM/SA miss walks for
200x/1000x longread, and a stable **1.13x SLOWER** on shortreads_300x (three
runs: 1.13/1.14/1.12 — reproducible, not the noise floor).

**Reverted anyway**, on the weighting the corpus supplies. The long-read win is
23ms against a 2725ms query (0.8%), because decompression swamps it there. The
short-read loss lands on a 365ms query where tag walking really is ~23%. Making
the dominant case worse to speed up a case that is 99.4% decompression is the
wrong trade. Don't re-attempt without a long-read profile where the query is NOT
decompression-bound.

### Adopted on this corpus: `getTagAlt`, one walk instead of two

A single pass resolving an alias pair, replacing `getTag(a) ?? getTag(b)`:

| corpus          | two walks | one walk    |       |
| --------------- | --------- | ----------- | ----- |
| 1000x.longread  | 26.41ms   | **12.17ms** | 2.17x |
| 200x.shortread  | 6.80ms    | **4.54ms**  | 1.50x |
| 1000x.shortread | 37.07ms   | **24.89ms** | 1.49x |
| shortreads_300x | 8.25ms    | **5.66ms**  | 1.46x |
| volvox-sorted   | 1.25ms    | **0.86ms**  | 1.46x |

Faster on **every** case rather than trading one against another — which is the
difference between this and the `indexOf` hybrid. jbrowse's
`modifications-utils` `getTagAlt()` duck-types it, the same way it already
duck-types `getTag`, and `RegionBoundBamFeature` must delegate it or MD-less
reads silently fall back to the two-walk form.

Note when benchmarking any of this: **the `tags` getter populates `_cachedTags`,
after which `getTag` reads the cache instead of walking.** Touching `.tags`
anywhere in a harness — including in a correctness pass before the timed one —
makes every later `getTag` look ~free and understates the walk by 100x.
jbrowse's pileup path does not touch `.tags`, so the walk is what production
pays.

## Verification

`seq` and `CIGAR` compared byte-for-byte against the pre-change build over
**74181 records across all 24 indexed fixtures** — zero mismatches. `getTagAlt`
compared against `getTag(a) ?? getTag(b)` over every record of the jb2bench
corpus plus the fixtures — zero mismatches — and pinned by unit tests covering
both orderings when a record carries both names.

The 4-base table sits behind a warmup counter, so the suite would otherwise
never execute it: `record.test.ts` has a test that crosses the warmup and
re-runs every seq case. It was mutation-checked (breaking the leftover-pair
branch makes it fail).

## Methodology note

ADR 0003's warning got worse, not better — this box idles at load average ~20 on
16 cores. Timing an accessor by re-querying between passes let decompression
noise swamp deltas under ~20%, and the same fixture flipped direction between
runs. What worked: fetch the record set ONCE per build, then alternate timed
passes over the same arrays. Neither `seq` nor the CIGAR string build is
memoized, so a repeated pass redoes exactly the work under test with no I/O in
the loop. min-of-41, alternating order. Anything under ~1.2x on a sub-2ms case
is still noise.
