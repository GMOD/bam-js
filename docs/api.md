# API

## `new BamFile(opts)`

| option                             | description                                               |
| ---------------------------------- | --------------------------------------------------------- |
| `bamPath`/`bamUrl`/`bamFilehandle` | local path, remote URL, or a generic-filehandle2 object   |
| `baiPath`/`baiUrl`/`baiFilehandle` | BAI index. defaults to the `.bai` sibling of the BAM      |
| `csiPath`/`csiUrl`/`csiFilehandle` | CSI index, required for chromosomes longer than 2^29      |
| `renameRefSeqs`                    | `(refName: string) => string` applied to header ref names |
| `recordClass`                      | custom class extending `BamRecord` (see below)            |
| `bgzfWorkerPool`                   | worker pool to inflate chunks on                          |
| `maxCacheBytes`                    | per-file cache ceiling in decompressed bytes. default 1GB |
| `cacheIdleTimeoutMs`               | drop a cached chunk after this long unread. default 3min  |
| `cacheBudget`                      | `SharedBudget` bounding several files together            |

The `path`/`url` forms are convenience wrappers for generic-filehandle2's
`LocalFile` and `RemoteFile`. The cache options are covered in
[caching.md](caching.md).

## `new HtsgetFile(opts)`

`baseUrl`, `trackId`, `fetch` and `recordClass`, as above.

## `getRecordsForRange(refName, start, end, opts?)`

`start`/`end` are 0-based half-open. `opts`:

| option          | description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `signal`        | `AbortSignal` to stop processing                                    |
| `viewAsPairs`   | re-dispatch requests to find mate pairs. default false              |
| `pairAcrossChr` | let `viewAsPairs` pair across chromosomes. default false            |
| `maxInsertSize` | distance limit for `viewAsPairs` within a chromosome. default 200kb |
| `onProgress`    | `(bytesDownloaded, totalBytes?) => void`, called per BGZF chunk     |

Records come back unfiltered, and are shared between overlapping queries — treat
them as read-only.

## Other methods

| method                                     | returns                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `getHeader(opts?)`                         | the parsed SAM header. called automatically by queries and cached                                               |
| `getHeaderText(opts?)`                     | the raw header string                                                                                           |
| `indexCov(refName, start?, end?)`          | `{start, end, score}[]` read density over 16kb windows, from the BAI linear index. `[]` for CSI, which has none |
| `lineCount(refName)`                       | records on `refName` from the index's pseudo-bin, or 0 if absent                                                |
| `hasRefSeq(refName)`                       | whether `refName` is in the file                                                                                |
| `estimatedBytesForRegions(regions, opts?)` | compressed bytes a `{refName, start, end}[]` would fetch — useful for warning before a large query              |
| `clearFeatureCache()`                      | drops the parsed-chunk cache immediately                                                                        |

## BamRecord

```typescript
// Core alignment fields
record.fileOffset // "file offset" based id -- not a true file offset
record.ref_id // numerical sequence id from SAM header
record.start // 0-based start coordinate
record.end // 0-based end coordinate
record.name // QNAME
record.seq // sequence string
record.qual // Uint8Array of quality scores (null if SEQ is empty)
record.CIGAR // CIGAR string e.g. "50M2I48M"
record.flags // SAM flags integer
record.mq // mapping quality (undefined if 255)
record.strand // 1 or -1
record.template_length // TLEN

// Mate info
record.next_refid
record.next_pos

// Auxiliary data
record.tags // all aux tags e.g. {MD: "100", NM: 0}
record.getTag('MD') // one tag, without decoding the rest
record.getTagRaw('MD') // string tag as Uint8Array, skipping string conversion

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

// Utility
record.seqAt(idx) // single base at position
record.toJSON()
```

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
