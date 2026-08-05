# ADR 0003 — Where BAM query time actually goes, and which micro-optimizations to skip

Status: Accepted (rejects four optimizations)

## Context

Before tuning any parser path in this repo, know the cost breakdown. Measured
per query by timing `bam.read` / `unzipChunkSlice` / `readBamFeatures`
separately (min of 5):

| file                                                             | read  | unzip      | readBamFeatures |
| ---------------------------------------------------------------- | ----- | ---------- | --------------- |
| chr22_nanopore_subset, `22:0-1e8` (14.2 MB → 24.4 MB, 757 reads) | 12 ms | **172 ms** | 0.1 ms          |
| shortreads_300x, `1:0-3e8` (5.2 MB → 18.5 MB, 53.6k reads)       | 12 ms | **82 ms**  | 15 ms           |
| volvox-sorted, `ctgA:0-1e5` (0.4 MB → 2.5 MB, 9.6k reads)        | 6 ms  | 9 ms       | 3 ms            |

**BGZF decompression is 70–90% of a cold query.** Record _construction_ is
nearly free — `BamRecord` is a view over the decompressed buffer, so
`readBamFeatures` only walks block sizes and allocates one object per record.
Everything expensive is in the lazy accessors, paid only if the consumer touches
them. On 53k short reads: `tags` ≈ `seq` ≫ `CIGAR` > `name` ≫ `end`. On long
reads `CIGAR` dominates (74 ms for 757 records averaging 2171 ops).

The practical consequence: anything that avoids a re-decompress beats any amount
of parser micro-tuning. That is why ADR 0001 matters far more than this one, and
why the remaining decompression headroom lives in `bgzf-filehandle` (libdeflate
in wasm, roughly at parity with native `zlib` on the same data — the only real
win left there is parallelizing across BGZF blocks in workers).

## Decision

Four plausible-looking micro-optimizations were measured and **rejected**. Don't
re-attempt them without new evidence.

### 1. Rewriting the `CIGAR` string builder

> **Partially superseded by ADR 0012.** The two alternatives below are still
> losers and were re-measured as such. But a third one that was never tried here
> — splitting the concat into two appends, dropping the intermediate cons string
> — is worth 1.3–1.7x on long reads and has landed. "Don't rewrite this loop"
> was too strong a conclusion to draw from these two data points.

`get CIGAR` does `result += length + String.fromCharCode(opCode)` in a loop —
the top accessor cost on long reads. Two alternatives, 20k ops × 200 reps:

| approach                                                     | time       |
| ------------------------------------------------------------ | ---------- |
| current (`+= length + String.fromCharCode(op)`)              | **231 ms** |
| precomputed 16-entry op-char string table                    | 284 ms     |
| digits written into a `Uint8Array`, one `TextDecoder.decode` | 314 ms     |

V8's rope concatenation already beats both. The precomputed table is _slower_,
which is the counterintuitive part — don't assume it helps.

### 2. Allocation-free virtual-offset scanning in `BAI._parse`

The first pass calls `fromBytes` (allocating a `VirtualOffset`) for every
linear-index entry across every ref, only to keep the minimum. Replacing it with
numeric `minBlock`/`minData` tracking, 8237 entries × 60 reps:

| approach                                     | time         |
| -------------------------------------------- | ------------ |
| current (`findFirstData(f, fromBytes(...))`) | **0.845 ms** |
| numeric min, no allocation                   | 1.055 ms     |

Escape analysis already handles it. Index parse is 2.2 ms on the largest test
`.bai` (393 KB) anyway, and it is memoized per file.

### 3. Switching `get name` to `TextDecoder`

Decoding `read_name_length` bytes, 1M reps:

| length | `Array` + spread (current) | `TextDecoder` | `apply(subarray)` | `+=` concat |
| ------ | -------------------------- | ------------- | ----------------- | ----------- |
| 12     | **200 ms**                 | 329 ms        | 368 ms            | 317 ms      |
| 24     | **254 ms**                 | 406 ms        | 608 ms            | 730 ms      |
| 40     | 468 ms                     | **401 ms**    | 924 ms            | 1097 ms     |

The crossover sits at ~32–40 chars, right on top of typical Illumina read-name
length, so a threshold would buy nothing reliable either way.

### 4. Memoizing `get name`

`end`, `tags`, `length_on_ref` and friends are all memoized, so `name` looks
like an oversight — and memoizing it did measurably speed up `fetchPairs`, which
reads every record's name twice plus every candidate mate's once (warm
`viewAsPairs` query 20 → 6.7 ms).

Rejected anyway, because that is the only caller that re-reads a name.
`jbrowse-components`' `buildBaseFeatureData` reads `feature.get('name')` exactly
once per feature and copies it into its own `FeatureData`; the `readName` filter
in `BamAdapter.getFeatures` only fires when a user has typed a read-name filter.
A memo read once is pure cost, and here it is paid twice over on a 22 443-record
chunk: +180 KB for the extra field slot on every record whether or not `name` is
touched, and +520 KB of name strings pinned for as long as the chunk stays
cached — where today they die with the consumer's copy. `viewAsPairs`, the one
path that benefits, is not used by jbrowse-components at all.

Note the `name` crossover above is _not_ the same as the one in
`decodeTagString` (`SHORT_STRING_THRESHOLD = 32`), which was measured separately
for Z/H tag values and is a real win there — `TextDecoder`'s ~0.35 µs fixed
setup dominates at MD/RG/PG lengths, where char codes are 4x faster at 8 bytes
and 2x at 16.

## Benchmarking methodology

This dev box often sits at load average >100 on 16 cores, where single-shot
timings are worthless — accessors that weren't touched by a change moved 2x
between runs. What works:

- Build the baseline from `HEAD`'s `src` into a scratch dir with
  `git archive HEAD src tsconfig.json | tar -x -C <dir>` and `tsc` there. Never
  `git stash` — multiple agents share this worktree.
- Import **both** builds into one process and alternate call order, so CPU
  frequency ramp and page-cache state hit both sides equally. (Same lesson as
  `bgzf-filehandle` ADR 0001, which measured a phantom 26% from a cold→warm
  sequential A/B.)
- Report **min-of-N**, not mean or median. Under load the tail is noise; the
  floor is the signal.
