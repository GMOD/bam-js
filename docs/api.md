# API

## `new BamFile(opts)`

| option                             | description                                               |
| ---------------------------------- | --------------------------------------------------------- |
| `bamPath`/`bamUrl`/`bamFilehandle` | local path, remote URL, or a generic-filehandle2 object   |
| `baiPath`/`baiUrl`/`baiFilehandle` | BAI index. defaults to the `.bai` sibling of the BAM      |
| `csiPath`/`csiUrl`/`csiFilehandle` | CSI index, required for chromosomes longer than 2^29      |
| `renameRefSeqs`                    | `(refName: string) => string` applied to header ref names |
| `recordClass`                      | custom class extending `BamRecord` (see below)            |
| `fetchReferenceSequence`           | reference bases for reads with no `MD` tag (see below)    |
| `bgzfWorkerPool`                   | worker pool to inflate chunks on                          |
| `maxCacheBytes`                    | per-file cache ceiling in decompressed bytes. default 1GB |
| `cacheIdleTimeoutMs`               | drop a cached chunk after this long unread. default 3min  |
| `cacheBudget`                      | `SharedBudget` bounding several files together            |

The `path`/`url` forms are convenience wrappers for generic-filehandle2's
`LocalFile` and `RemoteFile`; `path` reads local disk, so it is node-only. The
[caching.md](caching.md) covers the cache options.

## `new HtsgetFile(opts)`

`baseUrl`, `trackId`, `recordClass` and `fetchReferenceSequence` as above, plus
a `fetch` to attach auth headers with. There is no index here — the server
decides what a range returns — so it ignores the mate-pairing options, and takes
the cache options without using them, since ticket responses never reach the
chunk cache.

## `streamBamRecords(opts)`

Reads every record of a BAM in file order, without an index — for files no index
can address, such as an unsorted BAM or one still name-sorted as it came off the
sequencer.

```js
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({
  bamUrl: 'reads.bam',
  onHeader: h => {
    console.log(h.headerText, h.indexToChr)
  },
})) {
  for (const record of records) {
    // ...
  }
}
```

| option                                   | description                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `bamFilehandle` / `bamPath` / `bamUrl`   | the source, as in `BamFile`                                               |
| `onHeader`                               | fires once before the first batch, with the header text and ref-seq table |
| `windowSize`                             | compressed bytes per read. default 1MB, floored at one BGZF block         |
| `readAhead`                              | window reads in flight at once. default 4                                 |
| `bgzfWorkerPool`                         | inflate windows on a worker pool, as in `BamFile`                         |
| `recordClass`, `renameRefSeqs`, `signal` | as in `BamFile`                                                           |

`readAhead` is what makes a remote walk tolerable, and the depth is the part
that matters rather than the prefetching. One outstanding read overlaps a round
trip with only the CPU spent on the window before it, which measured at **no
gain at all**; four outstanding turn N sequential waits into roughly N/4. Over a
local server holding each response for 20ms, an 18MB BAM walked in 196ms at
depth 4 against 519ms at depth 1, and at 100ms of latency 1.9s against 7.4s.

It costs `depth` windows of compressed bytes held at once, and up to `depth - 1`
wasted requests at the end of the file — a read's length is the only thing that
says the file has ended, so the reads queued behind the last one have already
gone out by the time it lands.

Without `bgzfWorkerPool` every window inflates on the calling thread. Over a
whole file that is long enough to be worth keeping off whichever thread draws,
so in a browser pass `getSharedWorkerPool()` or run the stream in a worker.

It yields an **array** of records per window rather than one record per `yield`:
a whole-file walk is tens of millions of records and an async generator pays a
promise per yield, so batching keeps the caller's inner loop synchronous. The
header arrives through `onHeader` because the stream has to parse it anyway to
find where the records start.

A standalone function rather than a `BamFile` method on purpose. It shares the
record and header parsers and nothing else, so a consumer who only streams pays
for neither `BAI`/`CSI` nor the chunk cache — 87KB minified against 111KB for
`BamFile`, over an identical wasm inflate bundle in both.

Records are views into the window they came from, as everywhere else here, so
holding one retains that whole window. Copy out the fields you want rather than
keeping a scattered handful of records from a large file.

## `getRecordsForRange(refName, start, end, opts?)`

`start`/`end` are 0-based half-open. `opts`:

| option          | description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `signal`        | `AbortSignal` to stop processing                                    |
| `viewAsPairs`   | issue extra queries to find mate pairs. default false               |
| `pairAcrossChr` | let `viewAsPairs` pair across chromosomes. default false            |
| `maxInsertSize` | distance limit for `viewAsPairs` within a chromosome. default 200kb |
| `onProgress`    | `(bytesDownloaded, totalBytes?) => void`, called per BGZF chunk     |

Records come back unfiltered, and overlapping queries share them — treat them as
read-only. They arrive in chunk order, which is **not** coordinate order, since
bins at different levels of the index cover overlapping spans, and `viewAsPairs`
mates follow everything else. Sort if you need position order. A `refName` the
file does not have is not an error: the query returns `[]`, as do `indexCov` and
`blocksForRange`.

A read comes back when it shares at least one base with the range, so one ending
exactly where the query begins does not — the same records `samtools view`
gives. A record covering no reference at all, such as an unmapped mate placed at
its mate's coordinate, still counts as covering the one base it sits at, as in
htslib's `bam_endpos()`.

## Other methods

Everything taking `opts?` takes `signal` and `onProgress`, the latter reporting
the index download when that call is what triggers it.

| method                                           | returns                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `getHeader(opts?)`                               | the parsed SAM header. called automatically by queries and cached                                               |
| `getHeaderText(opts?)`                           | the raw header string                                                                                           |
| `indexCov(refName, start?, end?)`                | `{start, end, score}[]` read density over 16kb windows, from the BAI linear index. `[]` for CSI, which has none |
| `lineCount(refName)`                             | records on `refName` from the index's pseudo-bin, or 0 if absent                                                |
| `hasRefSeq(refName)`                             | whether `refName` is in the file                                                                                |
| `estimatedBytesForRegions(regions, opts?)`       | compressed bytes a `{refName, start, end}[]` would fetch — useful for warning before a large query              |
| `blocksForRange(refName, start, end, opts?)`     | the `Chunk[]` a query would read — `minv`/`maxv` virtual offsets and a `fetchedSize()` apiece                   |
| `clearFeatureCache()`                            | drops the parsed-chunk cache immediately                                                                        |
| `getReferenceRegion(refName, start, end, opts?)` | a `PackedReference` for `forEachMismatch`'s `opts.ref`, via `fetchReferenceSequence`. `undefined` without one   |

## BamRecord

```typescript
// Core alignment fields
record.fileOffset // stable per-record id from its position, not a byte offset
record.ref_id // numerical sequence id from SAM header
record.start // 0-based start coordinate
record.end // 0-based end coordinate
record.length_on_ref // reference bases the alignment spans, 0 if unmapped
record.name // QNAME
record.seq // sequence string
record.seq_length // its length, without decoding it
record.qual // Uint8Array of quality scores (null if SEQ is empty)
record.CIGAR // CIGAR string e.g. "50M2I48M"
record.flags // SAM flags integer
record.mq // mapping quality (undefined if 255; `score` is an alias)
record.strand // 1 or -1
record.template_length // TLEN

// Mate info
record.next_refid
record.next_pos
record.pair_orientation // 'F1R2', 'R2F1', … for a paired read, else undefined

// Auxiliary data
record.tags // all aux tags e.g. {MD: "100", NM: 0}
record.getTag('MD') // one tag, without decoding the rest
record.getTagRaw('MD') // string tag as Uint8Array, skipping string conversion
record.getTagAlt('MM', 'Mm') // either of an alias pair, in one pass

// Typed-array views, for rendering without allocating strings
record.NUMERIC_MD // MD tag as Uint8Array
record.NUMERIC_CIGAR // Uint32Array of packed CIGAR operations
record.NUMERIC_SEQ // Uint8Array of 4-bit encoded sequence

// Flag methods
record.isPaired()
record.isProperlyPaired()
record.isSegmentUnmapped()
record.isMateUnmapped()
record.isReverseComplemented()
record.isMateReverseComplemented()
record.isRead1()
record.isRead2()
record.isSecondary()
record.isFailedQc()
record.isDuplicate()
record.isSupplementary()

// Mismatches (see below)
record.getMismatches(opts?) // Mismatch[]
record.forEachMismatch(cb, opts?) // the same, allocating nothing per difference
record.setReference(ref) // bases to resolve substitutions against
record.reference // whatever setReference bound, if anything

// Utility
record.seqAt(idx) // single base at position
record.toJSON()
```

`end`, `CIGAR` and `tags` memoize onto the record the first time you touch them;
everything else decodes on each access. Reads with more than 65535 CIGAR
operations store the real CIGAR in a `CG` tag, which `CIGAR`, `NUMERIC_CIGAR`
and `end` follow transparently — only the raw `num_cigar_ops` field still
reports the two-op placeholder.

## Mismatches

`getMismatches(opts?)` returns every difference between the read and the
reference. `forEachMismatch(callback, opts?)` reports the same set without
allocating an object per difference, passing the fields below as arguments in
that order — the same callback `@gmod/cram`'s method of the same name takes.

```typescript
// for a read at 100 with CIGAR 5M1I4M2D3M, SEQ ACGGTCAACGTTA, MD 3A5^GG3
record.getMismatches()
// [
//   // X at 103: read G over reference A (65), quality 25
//   { code: 88, refPos: 103, length: 1, bases: 'G', qual: 25, refBaseCode: 65, clipLength: 0 },
//   // I before 105: one read base, C
//   { code: 73, refPos: 105, length: 0, bases: 'C', qual: -1, refBaseCode: 0, clipLength: 1 },
//   // D at 109: two reference bases
//   { code: 68, refPos: 109, length: 2, bases: '', qual: -1, refBaseCode: 0, clipLength: 0 },
// ]

// the same set, without an object per difference
record.forEachMismatch(
  (code, refPos, length, bases, qual, refBaseCode, clipLength) => {
    if (code === MISMATCH_SUBST) {
      drawBase(refPos, bases, qual)
    }
  },
  { start, end, origin: record.start }, // every option is optional, see below
)

// substitutions resolved against a reference window you fetched yourself,
// rather than one bound to the record
const ref = await bam.getReferenceRegion('chr1', start, end)
record.forEachMismatch(cb, { ref, start, end })
```

[cigar-and-md.md](cigar-and-md.md) walks that read through the two fields the
methods read.

| Field         | Meaning                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `code`        | char code of `X` = substitution, `I` = insertion, `D` = deletion, `N` = reference skip, `S` = soft clip, `H` = hard clip |
| `refPos`      | 0-based reference position                                                                                               |
| `length`      | reference bases covered: 1 for a substitution, the deleted or skipped length for `D`/`N`, 0 for insertions and clips     |
| `bases`       | the substituted base, or the inserted bases; empty for `D`/`N`/`S`/`H`                                                   |
| `qual`        | quality of a substituted base, `-1` when the read stores none                                                            |
| `refBaseCode` | char code of the reference base a substitution replaces, `0` when unknown                                                |
| `clipLength`  | read bases consumed: the inserted or clipped length, else 0                                                              |

Compare `code` against the exported `MISMATCH_SUBST`, `MISMATCH_INSERTION`, …
constants. They are CIGAR char codes, deliberately the same values `@gmod/cram`
reports, and are **not** the packed-CIGAR op numbers — `MISMATCH_DELETION` is 68
(`'D'`), not 2.

`opts`:

| option         | description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| `start`, `end` | only report differences touching this reference range, 0-based half-open |
| `origin`       | what reported positions are relative to; 0 (reference) by default        |
| `ref`          | a `PackedReference` to resolve substitutions against, for this call only |

`origin: record.start`, as above, gives read-relative positions. The window
stays absolute either way — it describes a region of the reference, not a
position in the output — so a read-relative consumer can still clip to a genomic
viewport. `origin` exists so a consumer with its own coordinate convention can
hand its callback straight in rather than wrapping it in a converting one, which
`@gmod/cram` measured at ~17% of its walk. That library's `forEachMismatch`
takes the same option with the same meaning.

### Where the reference bases come from

The walk can only report a substitution if something says what the reference
holds. In order:

1. the read's `MD` tag, when it has one — cheapest, and what the aligner
   asserted
2. `opts.ref`, a region you packed yourself with `packReference(seq, start)`
3. whatever `setReference` bound, which `getRecordsForRange` does for you when
   you built the file with `fetchReferenceSequence`

With none of them, the walk still reports indels and clips in full and skips
substitutions entirely.

`getRecordsForRange` calls `fetchReferenceSequence(refName, start, end, opts?)`
at most once per query, for the union span of the reads that lack `MD`, and
never for a query whose reads all carry one. The bases it returns must **begin
at `start`**; returning fewer than asked for is fine (the end of a contig, or a
source declining a big span), and the reads that shorter region misses stay
unresolved.

That union is the query's range plus however far its edge reads overhang it, and
nothing clamps it for you — a BAM holding whole chromosomes as reads can make it
a chromosome. Clamp inside your callback if your sequence source cannot afford
that, and resolve those reads a window at a time with `getReferenceRegion` and
`opts.ref`, as above.

That is also the answer to why `setReference` throws unless the region covers
the whole read: queries share their records (see
[ADR 0006](../agent-docs/adr/0006-cached-records-are-shared-and-must-not-be-mutated.md)),
so a binding that varied per query would make one query's reads answer out of
another's region. A per-call `opts.ref` retains nothing and takes any extent.

### Without a `BamRecord`

`forEachMismatchNumeric(cigar, seq, seqLength, md, qual, ref, refStart, windowStart, windowEnd, origin, callback)`
is the walk itself, for callers holding BAM's packed arrays without a record
around them — a SAM parser, or a worker someone posted the typed arrays to.
`origin` is the same knob as the option: pass the read's own start for
read-relative positions, 0 for reference ones.

`packReference(seq, start)` builds the region these take, and
`referenceNibble(ref, i)` with `CHAR_CODE_FROM_NIBBLE` read a base back out of
one — `i` is an index into the region, not a reference coordinate.

## Custom record class

```typescript
import { BamFile, BamRecord } from '@gmod/bam'

class CustomBamRecord extends BamRecord {
  get customProperty() {
    return `custom-${this.name}`
  }
}

const bam = new BamFile<CustomBamRecord>({
  bamPath: 'test.bam',
  recordClass: CustomBamRecord,
})

// records are typed as CustomBamRecord[]
const records = await bam.getRecordsForRange('ctgA', 0, 50000)
```

## Everything the package exports

There are no subpath exports, so a consumer typing a wrapper around any of the
above can only name these types by importing them from here.

| export                                                                                                                       | what it is                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `BamFile`, `HtsgetFile`, `BamRecord`                                                                                         | the three classes above                                                   |
| `BAI`, `CSI`                                                                                                                 | the index parsers, for reading an index without its BAM                   |
| `streamBamRecords`                                                                                                           | the index-free whole-file walk                                            |
| `DEFAULT_MAX_CACHE_BYTES`, `DEFAULT_CACHE_IDLE_TIMEOUT_MS`                                                                   | the cache defaults, to adjust rather than replace                         |
| `MISMATCH_SUBST`, `MISMATCH_INSERTION`, `MISMATCH_DELETION`, `MISMATCH_REF_SKIP`, `MISMATCH_SOFT_CLIP`, `MISMATCH_HARD_CLIP` | the `code` values to compare against                                      |
| `forEachMismatchNumeric`                                                                                                     | the walk without a record around it                                       |
| `packReference`, `referenceNibble`, `CHAR_CODE_FROM_NIBBLE`                                                                  | build a packed reference region, and read a base back out of one          |
| `BamOpts`, `BaseOpts`                                                                                                        | _type_ — the options the query and index methods take                     |
| `Mismatch`, `MismatchCallback`, `MismatchOptions`                                                                            | _type_ — what `getMismatches` returns, and what `forEachMismatch` takes   |
| `PackedReference`, `NumericCigar`, `IndexCovEntry`                                                                           | _type_ — the shapes those return                                          |
| `Chunk`, `Offset`, `OffsetCoords`                                                                                            | _type_ — what `blocksForRange` hands back                                 |
| `BamRecordClass`, `BamRecordLike`, `ReferenceSequenceFetcher`                                                                | _type_ — for the `recordClass` and `fetchReferenceSequence` options       |
| `StreamBamOptions`, `BamStreamHeader`                                                                                        | _type_ — what `streamBamRecords` takes, and what its `onHeader` gets      |
| `Fetcher`                                                                                                                    | _type_ — re-exported from generic-filehandle2, for `HtsgetFile`'s `fetch` |
