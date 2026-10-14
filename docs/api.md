# API reference

Every coordinate in this API is 0-based half-open. The [README](../README.md)
has a quick start.

- [`BamFile`](#bamfile): open a file and query a region
- [`HtsgetFile`](#htsgetfile): query an htsget server
- [`streamBamRecords`](#streambamrecords): read a whole file without an index
- [`BamRecord`](#bamrecord): one alignment
- [Mismatches](#mismatches): the differences between a read and the reference
- [Exports](#exports)

## `BamFile`

```typescript
const bam = new BamFile({
  bamUrl: 'https://example.com/file.bam',
  baiUrl: 'https://example.com/file.bam.bai',
})
```

### Options

| Option                               | Default                  | Description                                                                                        |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `bamUrl`, `bamPath`, `bamFilehandle` |                          | the BAM, as a URL, a local path, or a generic-filehandle2 handle                                   |
| `baiUrl`, `baiPath`, `baiFilehandle` | the BAM's `.bai` sibling | a BAI index                                                                                        |
| `csiUrl`, `csiPath`, `csiFilehandle` |                          | a CSI index, required for references longer than 2^29                                              |
| `fetchReferenceSequence`             |                          | reference bases for reads with no `MD` tag; see [Reference sequence](#reference-sequence)          |
| `bgzfWorkerPool`                     |                          | a worker pool, or the promise of one, to decompress on; see the [README](../README.md#worker-pool) |
| `maxCacheBytes`                      | 1 GB                     | decompressed bytes of chunks to keep; see [caching.md](caching.md)                                 |
| `cacheIdleTimeoutMs`                 | 3 minutes                | drop a chunk nothing has read for this long                                                        |
| `cacheBudget`                        |                          | a `SharedBudget` that bounds several files together                                                |
| `renameRefSeqs`                      |                          | `(refName) => string`, applied to the header's reference names                                     |
| `recordClass`                        | `BamRecord`              | a `BamRecord` subclass to return from queries; see [recordClass](#recordclass)                     |

A `path` reads local disk, so it works only in node.

### Methods

| Method                                           | Returns                        | Description                                                                 |
| ------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------- |
| `getRecordsForRange(refName, start, end, opts?)` | `Promise<BamRecord[]>`         | records overlapping the range; `[]` for a name the file lacks               |
| `getHeader(opts?)`                               | parsed SAM header              | the header, parsed once and cached                                          |
| `getHeaderText(opts?)`                           | `Promise<string>`              | the header text                                                             |
| `hasRefSeq(refName, opts?)`                      | `Promise<boolean>`             | whether the file has the reference                                          |
| `lineCount(refName, opts?)`                      | `Promise<number>`              | records on the reference, from the index; 0 if absent                       |
| `indexCov(refName, start?, end?, opts?)`         | `{ start, end, score }[]`      | read density over 16 kb windows, from the BAI linear index; `[]` for CSI    |
| `estimatedBytesForRegions(regions, opts?)`       | `Promise<number>`              | compressed bytes a `{ refName, start, end }[]` would fetch                  |
| `blocksForRange(refName, start, end, opts?)`     | `Promise<Chunk[]>`             | the chunks a query would read                                               |
| `getReferenceRegion(refName, start, end, opts?)` | `PackedReference \| undefined` | reference bases for `forEachMismatch`'s `ref`, via `fetchReferenceSequence` |
| `clearFeatureCache()`                            |                                | drop the chunk cache now                                                    |

Every `opts` takes `signal` and `onProgress`. On a method that downloads the
index, `onProgress` reports that download.

| Property                   | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `chrToIndex`, `indexToChr` | reference name to numeric id, and id to `{ refName, length }` |
| `header`                   | the header text, once a query or `getHeader` has read it      |
| `index`                    | the `BAI` or `CSI` index                                      |
| `bam`                      | the BAM filehandle                                            |

### `getRecordsForRange` options

| Option          | Default  | Description                                                        |
| --------------- | -------- | ------------------------------------------------------------------ |
| `signal`        |          | an `AbortSignal` that cancels the query                            |
| `onProgress`    |          | `(bytesDownloaded, totalBytes) => void`, called per chunk          |
| `viewAsPairs`   | `false`  | also fetch the mate of each read whose mate lies outside the range |
| `pairAcrossChr` | `false`  | with `viewAsPairs`, also fetch mates on other references           |
| `maxInsertSize` | `200000` | with `viewAsPairs`, skip mates farther away than this              |

A read is returned when it shares at least one base with the range, as in
`samtools view`. A record that covers no reference, such as an unmapped read
placed at its mate's position, covers the one base it sits at.

Records arrive in index chunk order, which is not coordinate order, and
`viewAsPairs` mates come last, so sort them if you need position order.
Overlapping queries share records, so treat them as read-only
([ADR 0006](../agent-docs/architecture-decision-records/0006-cached-records-are-shared-and-must-not-be-mutated.md)).

### Reference sequence

`fetchReferenceSequence(refName, start, end, opts?)` returns reference bases
beginning at `start`. bam-js calls it at most once per query, for the span of
the reads that have no `MD` tag, and not at all when every read has one. The
callback can return fewer bases than asked for, for example at the end of a
contig, and bam-js then reports no substitutions for the reads past the bases it
returned.

The span is the query's range plus however far its edge reads extend past it,
and bam-js does not clamp it, so for a BAM of reads as long as a chromosome, the
span can be the whole chromosome. A sequence source that cannot afford that can
clamp inside the callback and resolve the remaining reads a window at a time
with `getReferenceRegion` and the mismatch `ref` option.

### `recordClass`

Queries return instances of this `BamRecord` subclass, so a consumer can add
methods to the record instead of wrapping it. `@gmod/cram` takes the same
option.

```typescript
class MyRecord extends BamRecord {
  get label() {
    return `${this.name}:${this.start}`
  }
}

const bam = new BamFile<MyRecord>({ bamUrl, recordClass: MyRecord })
```

## `HtsgetFile`

```typescript
const bam = new HtsgetFile({
  baseUrl: 'https://htsget.example.com/reads',
  trackId: 'NA12878',
  fetch: (url, init) => {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  },
})
```

`HtsgetFile` takes `baseUrl` and `trackId`, plus `recordClass` and
`fetchReferenceSequence` as in `BamFile`, and has the same query methods. The
optional `fetch` makes the ticket request and the requests for the data blocks
the ticket lists. Those blocks can be on another host, so attach credentials
only for hosts you trust.

The server decides what a range returns, so `HtsgetFile` ignores the
mate-pairing options. It accepts the cache options but does not use them.

## `streamBamRecords`

`streamBamRecords` reads every record of a BAM in file order without an index,
for a file no index can address, such as an unsorted or name-sorted BAM. It
yields an array of records per window.

```typescript
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({
  bamUrl: 'reads.bam',
  onHeader: h => console.log(h.headerText),
})) {
  for (const record of records) {
    // ...
  }
}
```

| Option                                   | Default | Description                                        |
| ---------------------------------------- | ------- | -------------------------------------------------- |
| `bamUrl`, `bamPath`, `bamFilehandle`     |         | the BAM, as in `BamFile`                           |
| `onHeader`                               |         | called once before the first batch; see below      |
| `windowSize`                             | 1 MB    | compressed bytes per read, at least one BGZF block |
| `readAhead`                              | 4       | window reads in flight at once                     |
| `bgzfWorkerPool`                         |         | a worker pool to decompress on, as in `BamFile`    |
| `recordClass`, `renameRefSeqs`, `signal` |         | as in `BamFile`                                    |

`onHeader` receives an object with the header text as `headerText`, the header
parsed into lines as `samHeader`, and the reference tables as `chrToIndex` and
`indexToChr`, as on `BamFile`.

Without `bgzfWorkerPool`, the whole file decompresses on the calling thread, so
in a browser pass `getSharedWorkerPool()` or run the stream in a worker. A
record is a view into its window, so a record you keep holds that whole window
in memory; copy the fields you need instead.
[optimizations.md](optimizations.md#streaming-a-whole-file) has the measurements
behind `readAhead` and the batching.

## `BamRecord`

### Properties

| Property                 | Type                           | Description                                                 |
| ------------------------ | ------------------------------ | ----------------------------------------------------------- |
| `name`                   | `string`                       | read name (`QNAME`)                                         |
| `ref_id`                 | `number`                       | numeric reference id; `indexToChr` gives the name           |
| `start`                  | `number`                       | 0-based start                                               |
| `end`                    | `number`                       | 0-based exclusive end, at least `start + 1`                 |
| `length_on_ref`          | `number`                       | reference bases the alignment covers; 0 when unmapped       |
| `strand`                 | `1 \| -1`                      | the strand the read mapped to                               |
| `mq`, `score`            | `number \| undefined`          | mapping quality; `undefined` for 255                        |
| `flags`                  | `number`                       | SAM flags; see [Flag methods](#flag-methods)                |
| `CIGAR`                  | `string`                       | CIGAR, such as `50M2I48M`                                   |
| `seq`                    | `string`                       | read sequence                                               |
| `seq_length`             | `number`                       | read length, without decoding the sequence                  |
| `qual`                   | `Uint8Array \| null`           | base qualities; `null` when `SEQ` is empty or `QUAL` is `*` |
| `tags`                   | `object`                       | every auxiliary tag; `getTag` is faster for one             |
| `next_refid`, `next_pos` | `number`                       | the mate's reference id and position (SAM `RNEXT`, `PNEXT`) |
| `template_length`        | `number`                       | SAM `TLEN`                                                  |
| `pair_orientation`       | `string \| undefined`          | `F1R2`-style orientation; `undefined` for an unpaired read  |
| `fileOffset`             | `number`                       | an id unique to the record within the file                  |
| `reference`              | `PackedReference \| undefined` | whatever `setReference` bound                               |

`end`, `CIGAR` and `tags` decode on first access and then stay on the record.
Every other field decodes on each access. A read with more than 65535 CIGAR
operations stores its CIGAR in a `CG` tag, and `CIGAR`, `NUMERIC_CIGAR`, `end`
and `num_cigar_ops` all read the real CIGAR from it.

### Methods

| Method                       | Returns                   | Description                                                       |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `getTag(name)`               | tag value or `undefined`  | one auxiliary tag, without decoding the rest                      |
| `getTagRaw(name)`            | `Uint8Array \| undefined` | a string tag's bytes, skipping the conversion to a string         |
| `getTagAlt(name, alt)`       | tag value or `undefined`  | either of two alias tags, such as `MM` and `Mm`, in one pass      |
| `seqAt(i)`                   | `string \| undefined`     | the base at a read position                                       |
| `getMismatches(opts?)`       | `Mismatch[]`              | each difference from the reference; see [Mismatches](#mismatches) |
| `forEachMismatch(cb, opts?)` |                           | the same differences, one call each                               |
| `setReference(ref)`          |                           | bind reference bases to resolve substitutions against             |
| `toJSON()`                   | object                    | the record as a plain object                                      |

### Flag methods

Each returns a `boolean`.

| Method                        | True when                               |
| ----------------------------- | --------------------------------------- |
| `isPaired()`                  | the read is paired                      |
| `isProperlyPaired()`          | both segments mapped as a proper pair   |
| `isSegmentUnmapped()`         | this read did not map                   |
| `isMateUnmapped()`            | the mate did not map                    |
| `isReverseComplemented()`     | the read mapped to the reverse strand   |
| `isMateReverseComplemented()` | the mate mapped to the reverse strand   |
| `isRead1()`, `isRead2()`      | the read is the first or second segment |
| `isSecondary()`               | the alignment is secondary              |
| `isSupplementary()`           | the alignment is supplementary          |
| `isFailedQc()`                | the read failed quality control         |
| `isDuplicate()`               | the read is a PCR or optical duplicate  |

### Typed arrays and raw fields

The properties below read the record's bytes without building strings, for
renderers and other code that walks many records.

| Property           | Contents                                                                                |
| ------------------ | --------------------------------------------------------------------------------------- |
| `NUMERIC_CIGAR`    | packed CIGAR operations, as BAM stores them                                             |
| `NUMERIC_SEQ`      | the sequence, two 4-bit bases per byte                                                  |
| `NUMERIC_MD`       | the `MD` tag's bytes                                                                    |
| `byteArray`        | the decompressed buffer that holds the record                                           |
| `b0`               | the offset of the read name in `byteArray`                                              |
| `seqStart`         | the offset of `SEQ` in `byteArray`                                                      |
| `tagsStart`        | the offset of the auxiliary tags in `byteArray`                                         |
| `bin_mq_nl`        | BAM's packed bin, mapping quality and name length                                       |
| `flag_nc`          | BAM's packed flags and CIGAR operation count                                            |
| `read_name_length` | bytes in the read name, including its terminator                                        |
| `num_cigar_ops`    | CIGAR operations, counting the real CIGAR in a `CG` tag                                 |
| `num_cigar_bytes`  | bytes of the stored CIGAR field, which is a placeholder when a `CG` tag holds the CIGAR |
| `num_seq_bytes`    | bytes of `NUMERIC_SEQ`                                                                  |

## Mismatches

`getMismatches(opts?)` returns each difference between the read and the
reference. `forEachMismatch(callback, opts?)` passes the same fields to
`callback` as arguments, in the order below, without allocating an object per
difference. `@gmod/cram` has the same two methods with the same callback.

```typescript
// for a read at 100 with CIGAR 5M1I4M2D3M, SEQ ACGGTCAACGTTA, MD 3A5^GG3
record.getMismatches()
// [
//   { code: 88, refPos: 103, length: 1, bases: 'G', qual: 25, refBaseCode: 65, clipLength: 0 },
//   { code: 73, refPos: 105, length: 0, bases: 'C', qual: -1, refBaseCode: 0, clipLength: 1 },
//   { code: 68, refPos: 109, length: 2, bases: '', qual: -1, refBaseCode: 0, clipLength: 0 },
// ]

record.forEachMismatch(
  (code, refPos, length, bases, qual, refBaseCode, clipLength) => {
    if (code === MISMATCH_SUBST) {
      drawBase(refPos, bases, qual)
    }
  },
  { start, end, origin: record.start },
)
```

[cigar-and-md.md](cigar-and-md.md) walks that read through the `CIGAR` and `MD`
fields the methods read.

| Field         | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `code`        | char code of `X` substitution, `I` insertion, `D` deletion, `N` skip, `S` or `H` clip |
| `refPos`      | 0-based reference position                                                            |
| `length`      | reference bases covered: 1 for `X`, the length for `D` and `N`, else 0                |
| `bases`       | the substituted or inserted bases                                                     |
| `qual`        | quality of a substituted base, or `-1`                                                |
| `refBaseCode` | char code of the reference base a substitution replaces, or `0` when unknown          |
| `clipLength`  | read bases consumed by an insertion or clip, else 0                                   |

Compare `code` against the exported `MISMATCH_SUBST`, `MISMATCH_INSERTION` and
the other `MISMATCH_*` constants. They are CIGAR char codes, the same values
`@gmod/cram` reports, so `MISMATCH_DELETION` is 68 (`'D'`) rather than BAM's
packed op number 2.

| Option         | Description                                                                           |
| -------------- | ------------------------------------------------------------------------------------- |
| `start`, `end` | a reference range; only differences touching it are reported                          |
| `origin`       | reported positions are relative to it; 0 by default, `record.start` for read-relative |
| `ref`          | a `PackedReference` to resolve substitutions against, for this call only              |

`start` and `end` stay reference coordinates whatever `origin` is.

### Where the reference bases come from

A substitution can be reported only when something supplies the reference base.
The walk uses the first of these that applies:

1. the read's `MD` tag
2. `opts.ref`, a region packed with `packReference(seq, start)`
3. the reference `setReference` bound, which `getRecordsForRange` binds when the
   file has a `fetchReferenceSequence`

With none of them, the walk reports indels and clips but no substitutions.
`setReference` throws unless the region covers the whole read, because queries
share records and a per-query binding would give one query's reads another
query's bases. `opts.ref` keeps nothing on the record and takes any region.

### Without a `BamRecord`

`forEachMismatchNumeric(cigar, seq, seqLength, md, qual, ref, refStart, windowStart, windowEnd, origin, callback)`
is the walk on BAM's packed arrays, for code that has them without a record,
such as a SAM parser or a worker that received the typed arrays.
`packReference(seq, start)` builds a reference region, and
`referenceNibble(ref, i)` with `CHAR_CODE_FROM_NIBBLE` reads a base back out of
one, where `i` is an index into the region.

## Exports

The package has no subpath exports, so these are the only names a consumer can
import.

| Export                                                                                                                       | Description                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `BamFile`, `HtsgetFile`, `BamRecord`                                                                                         | the classes above                                                   |
| `BAI`, `CSI`                                                                                                                 | the index parsers, for reading an index without its BAM             |
| `streamBamRecords`                                                                                                           | the whole-file walk                                                 |
| `DEFAULT_MAX_CACHE_BYTES`, `DEFAULT_CACHE_IDLE_TIMEOUT_MS`                                                                   | the cache defaults                                                  |
| `MISMATCH_SUBST`, `MISMATCH_INSERTION`, `MISMATCH_DELETION`, `MISMATCH_REF_SKIP`, `MISMATCH_SOFT_CLIP`, `MISMATCH_HARD_CLIP` | the mismatch `code` values                                          |
| `forEachMismatchNumeric`                                                                                                     | the mismatch walk without a record                                  |
| `packReference`, `referenceNibble`, `CHAR_CODE_FROM_NIBBLE`                                                                  | build a packed reference region and read bases from it              |
| `BamOpts`, `BaseOpts`                                                                                                        | _type_: the options the query and index methods take                |
| `Mismatch`, `MismatchCallback`, `MismatchOptions`                                                                            | _type_: the mismatch methods' result and arguments                  |
| `PackedReference`, `NumericCigar`, `IndexCovEntry`                                                                           | _type_: the results of `packReference`, `NUMERIC_CIGAR`, `indexCov` |
| `Chunk`, `Offset`, `OffsetCoords`                                                                                            | _type_: what `blocksForRange` returns                               |
| `BamRecordClass`, `BamRecordLike`, `ReferenceSequenceFetcher`                                                                | _type_: the `recordClass` and `fetchReferenceSequence` options      |
| `StreamBamOptions`, `BamStreamHeader`                                                                                        | _type_: `streamBamRecords`' options and `onHeader` argument         |
| `Fetcher`                                                                                                                    | _type_: `HtsgetFile`'s `fetch`, from generic-filehandle2            |
