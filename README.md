[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/bam-js/publish.yml?branch=main)

Parser for BAM files and their BAI/CSI indexes.

## Install

```bash
npm install @gmod/bam
```

## Usage

```typescript
import { BamFile } from '@gmod/bam'

const bam = new BamFile({ bamPath: 'test.bam' })

// same records as `samtools view test.bam ctgA:1-50000`
const records = await bam.getRecordsForRange('ctgA', 0, 50000)
```

Coordinates are 0-based half-open (not the same as `samtools view` inputs).
`bamPath` reads a local file, so it is node-only; in the browser pass a
filehandle or URL instead:

```typescript
import { BamFile } from '@gmod/bam'

const bam = new BamFile({
  bamUrl: 'https://example.com/yourfile.bam',
  baiUrl: 'https://example.com/yourfile.bam.bai',
})
```

## Usage with htsget

```typescript
import { HtsgetFile } from '@gmod/bam'

const bam = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
const records = await bam.getRecordsForRange('1', 2000000, 2000001)
```

htsget fetches the server's range as-is, so `viewAsPairs`, `pairAcrossChr` and
`maxInsertSize` are ignored.

For a server that requires authentication, pass a `fetch` that adds the bearer
token the spec calls for:

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

Your `fetch` is called for the ticket request and for the data-block urls the
ticket points at, so only attach credentials to hosts you trust — data blocks
may live on a third-party host, and the spec has servers put whatever those need
in each url's own `headers` field, which is applied either way.

## Documentation

### BamFile constructor

- `bamPath`/`bamUrl`/`bamFilehandle` - local path, remote URL, or a
  generic-filehandle2 object
- `baiPath`/`baiUrl`/`baiFilehandle` - BAI index. Defaults to the `.bai` sibling
  of `bamPath`/`bamUrl`
- `csiPath`/`csiUrl`/`csiFilehandle` - CSI index, required for chromosomes
  longer than 2^29
- `renameRefSeqs` - `(refName: string) => string` applied to header ref names
- `recordClass` - custom class extending `BamRecord` (see below)
- `maxCacheBytes` - budget for the parsed-chunk cache, in decompressed bytes.
  default: 1GB. A retention bound rather than a bound on peak memory — reads in
  flight and the last settled entry are never evicted. Size it to hold several
  queries: below one query's working set the hit rate drops to zero while the
  memory is retained anyway, so a number between the two is the worst choice
- `cacheIdleTimeoutMs` - drop a cached chunk once nothing has read it for this
  long. default: 3 minutes; `0` disables it. This is what makes the budget above
  a peak under panning rather than a level a parked page holds indefinitely, and
  it is the only thing that lowers the cache while nothing is happening. The
  clock runs from the last read of a chunk, so panning back and forth over one
  region never expires it

The `path`/`url` forms are convenience wrappers for generic-filehandle2's
`LocalFile` and `RemoteFile`.

### HtsgetFile constructor

- `baseUrl` - htsget reads endpoint, e.g. `https://htsget.example.com/reads`
- `trackId` - id of the resource under `baseUrl`
- `fetch` - `fetch` replacement for adding auth headers (see above)
- `recordClass` - custom class extending `BamRecord` (see below)

### async getRecordsForRange(refName, start, end, opts?)

- `refName` - chromosome to fetch from
- `start`/`end` - 0-based half-open coordinates
- `opts.signal` - `AbortSignal` to stop processing
- `opts.viewAsPairs` - re-dispatch requests to find mate pairs. default: false
- `opts.pairAcrossChr` - let `viewAsPairs` pair across chromosomes. default:
  false
- `opts.maxInsertSize` - distance limit for `viewAsPairs` within a chromosome.
  default: 200kb
- `opts.onProgress` - `(bytesDownloaded, totalBytes?) => void`, called per BGZF
  chunk for a determinate progress bar

Returned records are cached and shared between overlapping queries, so treat
them as read-only — attaching your own fields to a record mutates it for every
other query holding it.

Records come back unfiltered. Filter them yourself with the flag helpers and
`getTag`, which decodes one tag instead of all of them:

```typescript
const records = (await bam.getRecordsForRange('chr1', 0, 100000)).filter(
  r => r.isProperlyPaired() && !r.isSecondary() && r.getTag('RG') === 'rg1',
)
```

### async getHeader(opts?)

Returns the parsed SAM header. Called automatically by the query methods and
cached, so you only need it when you want the header itself.
`getHeaderText(opts?)` returns the raw header string.

### async indexCov(refName, start?, end?)

Returns `{start, end, score}` features estimating read density over 16kb
windows, derived from the BAI linear index. CSI has no linear index, so a
CSI-indexed file returns `[]`.

### async lineCount(refName)

Number of records on `refName` from the index's pseudo-bin (bin 37450 in BAI,
`n_mapped` in the SAM spec), or 0 if `refName` is absent.

### async hasRefSeq(refName)

Whether `refName` is present in the file.

### async estimatedBytesForRegions(regions, opts?)

Compressed bytes the given `{refName, start, end}[]` would fetch — useful for
warning before a large query.

### clearFeatureCache()

Drops the parsed-chunk cache.

### BamRecord

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

### Custom BamRecord class

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
console.log(records[0].customProperty)
```

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)

## Publishing

[Trusted publishing](https://docs.npmjs.com/about-trusted-publishing) via GitHub
Actions.

```bash
pnpm version patch  # or minor/major
```
