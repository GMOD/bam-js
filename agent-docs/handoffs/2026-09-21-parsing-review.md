# Handoff, 2026-09-21: parsing review — seven bugs, two index optimizations, nothing implemented

A review of `src/` against SAMv1.tex, CSIv1.tex and htslib's `hts.c`/`sam.c`
(`~/src/vendor/hts-specs`, `~/src/vendor/htslib`), cross-checked against how
jbrowse-components consumes the package. It changed no source. Everything below
waits on implementation, and each item says what evidence it rests on.

Line numbers are at `b80b203`.

## Suggested order

1. `max_off` pruning — the largest win jbrowse would see, and it is sound.
2. `>>> 4` for CIGAR op lengths — one character per site, and it breaks
   chromosome-scale assembly BAMs today.
3. QUAL `*` as `null` — the only disagreement with samtools across the whole
   hts-specs corpus.
4. The `block_size` guard — a corrupt file hangs the reader.
5. The `fetchPairs` dedupe.
6. The CSI `loffset` lower bound.
7. Everything else.

`max_off` wants its own ADR, and ADRs 0010 and 0017 each want a note pointing at
it: it changes what the early stop and the byte forecast are for.

## Bugs

### 1. `viewAsPairs` returns some mates twice

`fetchPairs` removes duplicate mate chunks by their virtual-offset span
(`bamFile.ts:861`), which catches identical spans but not overlapping ones. Two
mates' lookups can resolve to different merged spans over the same records, and
every mate in the overlap then comes back once per chunk.

Reproduced on `test_deletion_2_0.snps.bwa_align.sorted.grouped.bam`, reference
`Chromosome`, window 16000-17000 with `viewAsPairs: true`: 169 records, 146
distinct `fileOffset`s. The mate chunks are `0:179-165074:53878` and
`141294:22912-165074:53878`, and the 23 duplicates are the records they share. A
sweep of windows over five paired fixtures found no other case, but in four of
them no window fetched any mate at all, so the sweep says little.

Fix: pass the flattened mate chunks through `optimizeChunks`, whose
`makeDisjoint` step exists for exactly this, or drop repeated `fileOffset`s in
chunk order. The first should also save reads, though that is unmeasured.
jbrowse does not use `viewAsPairs`.

### 2. CIGAR op lengths of 2^27 or more decode negative

The spec defines a CIGAR op as a uint32 of `op_len << 4 | op`, and htslib shifts
it unsigned. `record.ts` shifts it signed at five sites: `:699`
(`_isCGTagPattern`), `:719`, `:735` and `:743` (`_computeLengthOnRef`) and
`:814` (`CIGAR`). `mismatches.ts` already uses `>>> 4`.

Reproduced with a synthetic record: a single `150000000M` op gives
`length_on_ref` of `-118435456`, `end` of `start + 1`, and `CIGAR` of
`-118435456M`.

This bites real files through the long-CIGAR placeholder. A record with more
than 65,535 ops stores `kSmN`, where `m` is its whole reference span, so any
contig alignment spanning more than 134,217,727bp gets a negative span and is
found only at its first base. A chromosome-scale contig is exactly that shape.
`_isCGTagPattern`'s `cigop >> 4 === seq_length` fails the same way for a read
longer than 134Mb.

Fix: `>>> 4` at all five sites. The `| 0` at `record.ts:777` keeps plain-array
CIGARs signed, which is harmless once every reader shifts unsigned.

### 3. QUAL `*` comes back as a run of 255s

SAMv1 §4.2.3: "When base qualities are omitted but the sequence is not, qual is
filled with 0xFF bytes". htslib prints `*` when `qual[0] == 0xff`
(`sam.c:4365`). `qual` (`record.ts:445`) returns the 0xFF bytes as scores, so
`forEachMismatch` reports a quality of 255 where `Mismatch.qual`'s own
documentation promises -1.

This is the only field that disagreed with samtools across the hts-specs corpus
(see below). The repo's own `samspec.bam`, `long_tag_list.bam` and
`long_tag_list2.bam` carry it too. jbrowse's renderer happens to map 255 to its
`QUAL_UNAVAILABLE`, but its `qualString` shows the reader "255 255 …".

Fix: `qual` returns `null` when the first byte is 0xFF, as it already does for
an empty SEQ.

### 4. A corrupt `block_size` hangs the reader

`readBamFeatures` (`bamFile.ts:964`) and `streamBamRecords` (`streamBam.ts:291`)
advance by `block_size`. A value of -4 or less leaves `blockStart` where it was,
so the loop pushes a record per iteration until the process runs out of memory.
htslib rejects any `block_len < 32` (`sam.c:794`). A bad index offset or a
damaged block is enough to freeze a tab or a worker.

Found by reading the arithmetic, not reproduced. Fix: throw when
`blockSize < 32`.

### 5. `indexCov` spikes before a reference's first read

Older samtools leaves leading zero entries in the BAI linear index. `indexCov`
(`bai.ts:254`) scores each window as the gap to the next entry, so the window
before the first read scores its whole absolute file offset: on a later
reference, every byte of every reference before it. htslib skips the leading
zeros on load and fills interior ones from the next entry (`hts.c:2970-2972`).

Seen in `HG00096_illumina_lowcov.bam.bai`, whose reference 10 starts
`0, 0, 0, 4682, 24330`. The spike there is window 2 at 43.2 against a median of
736.5, and it is small only because that file has data on one reference, so 4682
is just the header. No fixture has leading zeros on a later reference. jbrowse
does not call `indexCov`.

Fix: fill leading zeros with the first non-zero entry when building
`linearBlockPositions`. That is also a valid, tighter lower bound for
`getLowestChunk` in those windows.

### 6. The long-CIGAR path departs from the spec three ways

SAMv1 §4.2.2: if a CG tag is present and the first op clips the whole read, a
parser "is expected to update n_cigar_op and cigar with the real CIGAR stored in
the CG tag and remove the now-redundant CG tag".

- With the `kSmN` shape and no CG tag, `record.ts:767` returns an empty CIGAR.
  The spec only swaps when CG is present, so this should fall back to the stored
  two ops.
- `tags` still carries CG. In `cg.bam` that is a 72,192-element array, which
  jbrowse's `BamSlightlyLazyFeature.toJSON` serializes.
- `num_cigar_ops` reports the placeholder's 2 while `NUMERIC_CIGAR` has 72,192
  ops.

### 7. NUL padding in the header text

SAMv1 says `l_text` counts "any NUL padding", and htslib reads the text as a C
string. `bamFile.ts:467` and `streamBam.ts:276` decode all `l_text` bytes, so
padding would land in `header` and `parseHeaderText` would emit an entry for a
line of NULs. No fixture has padding, so this is untested in practice. Fix: cut
the text at the first NUL.

### Theoretical, not reproduced

htslib builds the linear index from mapped reads only, and when a reference has
placed-unmapped reads it walks the lower bound back to an earlier entry
(`hts.c:3496`). bam-js uses the entry as is, so an unmapped read that sits alone
in its chunk just before a window's first mapped read could be pruned. Across
every BAI fixture, querying with and without the lower bound returned the same
records in every window. Leave it unless a report turns up.

## Optimizations

### 1. htslib's `max_off` upper bound

htslib bounds a query from the right using the index alone (`hts.c:3515-3533`).
Start at the finest-level bin just right of the query end and walk right,
stepping up to the parent whenever the walk reaches a first child. The first
chunk of the first bin that exists is `max_off`. Every record in that bin starts
at or past the query end, and the file is coordinate-sorted, so every record at
or past `max_off` does too. Chunks starting at or past it can be dropped and the
rest trimmed to end there.

That is a bound, not a forecast. It rests on the same sort-order assumption
`appendInRange` and the early stop already make. It is not the linear-index
forecast ADR 0017 declined to prune with, which really can drop records.

```ts
function maxOff(binIndex, end, minShift, depth) {
  if (end > 2 ** (minShift + depth * 3)) {
    return undefined
  }
  const nBins = (2 ** ((depth + 1) * 3) - 1) / 7
  let bin =
    (2 ** (depth * 3) - 1) / 7 + Math.floor((end - 1) / 2 ** minShift) + 1
  if (bin >= nBins) {
    bin = 0
  }
  for (;;) {
    while (bin % 8 === 1) {
      bin = Math.floor((bin - 1) / 8)
    }
    if (bin === 0) {
      return undefined
    }
    const chunks = binIndex[bin]
    if (chunks?.length) {
      let min = chunks[0].minv
      for (const c of chunks) {
        if (compareOffsets(c.minv, min) < 0) {
          min = c.minv
        }
      }
      return min
    }
    bin++
  }
}
```

Bytes read (the lengths passed to `filehandle.read`) with the chunk cache
cleared before every query. Windows were 400bp to 500kb on the fixtures and
400bp to 50kb on jb2bench, spread over each reference's data. Records and their
order were identical in every window.

| file                         | now         | with `max_off` |
| ---------------------------- | ----------- | -------------- |
| out.bam                      | 299.0MB     | 175.7MB (−41%) |
| volvox-sorted.bam            | 10.3MB      | 7.9MB (−24%)   |
| ecoli_nanopore.bam           | 27.6MB      | 22.6MB (−18%)  |
| jb2bench 2mb.100x.shortread  | 67.2MB      | 55.6MB (−17%)  |
| ultra-long-ont…subsel.bam    | 336.1MB     | 286.3MB (−15%) |
| chr22_nanopore_subset.bam    | 526.5MB     | 452.0MB (−14%) |
| jb2bench 2mb.100x.longread   | 710.5MB     | 674.3MB (−5%)  |
| jb2bench 1000x.shortread     | 383.8MB     | 376.1MB (−2%)  |
| jb2bench 1000x/200x.longread | 4393/1032MB | unchanged      |

Requests fall further than bytes. A separate run over 1kb-200kb windows counted
out.bam 354 → 156, chr22_nanopore 524 → 323, ultra-long-ont 356 → 241, volvox 65
→ 34 and ecoli 61 → 34.

**Keep the early stop.** On the five fixtures where `max_off` bites, the early
stop saved no further byte on top of it. On jb2bench's 1000x.longread it is the
other way round. htslib's `compress_binning` merged every 16kb bin in that file
into its parent, leaving three bins. Bin 585 covers the first 128kb and opens
with a single 88MB chunk (`395:0-88760055:0`). The only bin to its right, 586,
starts at `177709547:0`, which is exactly where the last chunk a first-half
query can reach ends, and a second-half query has no bin to its right at all.
`max_off` prunes nothing there, and the early stop still saves 12% (5022MB →
4393MB).

**Trim or only drop.** Dropping chunks past `max_off` without trimming the rest
keeps most of the saving: out.bam 220.6MB instead of 175.7MB, chr22 462.9MB
instead of 452.0MB, ultra-long-ont 294.2MB instead of 286.3MB, and volvox and
ecoli unchanged. Trimming makes a chunk's cache key depend on the query end,
which is the sliding-key problem ADR 0019 parks. Measure a pan both ways before
choosing.

**The byte estimate.** `estimatedBytesForRegions` calls `blocksForRange`, so it
inherits the pruning. Today it misses by more than 5% on 20 of 74 out.bam
windows and 43 of 64 chr22_nanopore windows, and undershoots 1000x.longread by
27% (3226MB forecast, 4393MB read). Re-measure `chunksLikelyRead` after this
lands; it may have less left to forecast.

Implement it once in `IndexFile.blocksForRange`: both formats hold a `binIndex`,
and BAI is CSI with `minShift` 14 and `depth` 5. The mate lookups in
`fetchPairs` go through the same method and get the saving too.

### 2. CSI lower bound from `loffset`

CSI has no linear index, and `csi.ts:192` returns 0:0 as the lower bound. htslib
takes the `loffset` of the finest existing bin at or left of the query start
(`hts.c:3476-3488`), and `update_loff` (`hts.c:2426`) shows `loffset` is the
linear-index value at the bin's first window, so it is a valid lower bound.
bam-js already reads `loffset` in its first pass, for `firstDataLine`, and then
skips it in `getIndices` (`csi.ts:160`).

```ts
function csiMinOff(loffsets: Map<number, Offset>, beg, minShift, depth) {
  let bin = (2 ** (depth * 3) - 1) / 7 + Math.floor(beg / 2 ** minShift)
  let hit
  do {
    hit = loffsets.get(bin)
    if (hit) {
      break
    }
    const firstSibling = (((bin - 1) >> 3) << 3) + 1
    bin = bin > firstSibling ? bin - 1 : (bin - 1) >> 3
  } while (bin)
  return bin === 0 ? loffsets.get(0) : hit
}
```

Measured over the same 1kb-200kb windows, with identical records. It brings CSI
to BAI's level: volvox-sorted.bam.csi 9.9MB/76 requests → 9.2MB/65,
ecoli_nanopore.bam.csi 26.8MB/77 → 23.8MB/64, chr22_nanopore_subset.bam.csi
unchanged at 577.3MB. Combined with `max_off`: volvox 6.9MB/34, ecoli 19.6MB/37,
chr22 503.4MB/387.

## Cleanups

- `getRecordsForRange` asks the index for `min - 1` (`bamFile.ts:542`), a
  leftover from 2018's `f75da73` switch to 0-based coordinates. `appendInRange`
  drops everything the extra base adds. `estimatedBytesForRegions` queries
  without it, so the estimate and the read can resolve different chunk sets.
- `record.ts:478` cites `benchmarks/string-building.bench.ts` and `:675` cites
  `benchmarks/cigar-lifecycle.bench.ts`. Neither file exists.
- `fetchPairs` decodes every read name twice (`bamFile.ts:824` and `:832`).
- CSI's `maxBinNumber` uses `1 << ((depth + 1) * 3)`, which overflows at
  depth 10. No real index gets there; `2 **` costs nothing.

## The hts-specs conformance corpus

`hts-specs/test/sam/passed` holds 82 SAM files that exercise every field and tag
type. Converted with `samtools view -b` and compared field by field and tag by
tag against `samtools view`, all 316 records match except QUAL `*` (bug 3). The
decoder is conformant apart from that.

Worth adopting as a test that pins bug 3's fix and guards the tag decoder. Copy
the SAM files with their LICENSE and generate the BAMs at test time behind the
same samtools gate `samtoolsAgreement.test.ts` uses. Committing the converted
BAMs instead costs 660KB.

It does not cover the long-CIGAR path: its longest CIGAR, `cigar.pass6.sam`, is
60,853 ops, under the 65,535 limit. `cg.bam` covers that. It has no index files
and no NUL-padded header either.

## How the numbers were measured

The scripts lived in the session scratchpad and are gone, but they are short to
rebuild:

- Wrap a `LocalFile`'s `read` to sum lengths and count calls, and hand it to
  `BamFile` as `bamFilehandle`.
- Build one `BamFile` per variant and monkeypatch `index.blocksForRange` (or
  `getLowestChunk`) on each.
- Call `clearFeatureCache()` before every query, so each one measures a cold
  read.
- Compare variants by the list of `fileOffset`s they return, which checks both
  the record set and its order.

## What jbrowse-components uses

`plugins/alignments/src/BamAdapter/` uses `getRecordsForRange`,
`estimatedBytesForRegions`, `getHeader`, a `recordClass` subclass,
`forEachMismatchNumeric`, `packReference` and `getTagAlt`, and takes
`fileOffset` as the feature id. It does not use `viewAsPairs`, `indexCov`,
`fetchReferenceSequence` or `streamBamRecords`. So bugs 1 and 5 do not reach it,
and `max_off` is the change a jbrowse user would notice: fewer bytes per pan,
and a lower byte estimate, which means fewer "too much data" banners.
