# @gmod/bam

[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/bam-js/publish.yml?branch=main)

Read BAM files and their BAI or CSI indexes in node or the browser.

```bash
npm install @gmod/bam
```

## Quick start

```typescript
import { BamFile } from '@gmod/bam'

const bam = new BamFile({
  bamUrl: 'https://example.com/file.bam',
  baiUrl: 'https://example.com/file.bam.bai',
})

const records = await bam.getRecordsForRange('chr1', 10000, 20000)

for (const record of records) {
  for (const { code, refPos, bases } of record.getMismatches()) {
    console.log(record.name, String.fromCharCode(code), refPos, bases)
  }
}
```

Local files take `bamPath` and `baiPath`. A CSI index takes `csiUrl` or
`csiPath`, and is required for references longer than 2^29.

- Coordinates are 0-based half-open, where `samtools view` takes 1-based closed,
  so `samtools view file.bam ctgA:1-50000` returns the same records as
  `getRecordsForRange('ctgA', 0, 50000)`.
- An unknown reference returns `[]`.

## Mismatches

`record.getMismatches()` lists substitutions, insertions, deletions, reference
skips and clips.

```typescript
// a read at 100 with CIGAR 5M1I4M2D3M, SEQ ACGGTCAACGTTA and MD 3A5^GG3
for (const { code, refPos, length, bases } of record.getMismatches()) {
  console.log(String.fromCharCode(code), refPos, length, bases)
}
// X 103 1 G   substitution to G
// I 105 0 C   one base inserted before 105
// D 109 2     two reference bases deleted from 109
```

`code` is a CIGAR char code (88 for `X`). `String.fromCharCode(code)` gives the
letter without allocating a small string, since V8 interns single-character
strings, and bam-js uses it for speed too.

### Mismatches without an `MD` tag

A substitution inside an `M` run needs the read's `MD` tag or the reference
bases. Most aligners omit `MD`, so pass a `fetchReferenceSequence`, here backed
by [`@gmod/indexedfasta`](https://github.com/GMOD/indexedfasta-js):

```typescript
import { IndexedFasta } from '@gmod/indexedfasta'

const fasta = new IndexedFasta({ path: 'ref.fa', faiPath: 'ref.fa.fai' })

const bam = new BamFile({
  bamPath: 'file.bam',
  baiPath: 'file.bam.bai',
  fetchReferenceSequence: async (refName, start, end, opts) =>
    (await fasta.getSequence(refName, start, end, opts)) ?? '',
})
```

[docs/api.md](docs/api.md#reference-sequence) has the callback's contract.

## Records

A record is one alignment, a line of `samtools view`.

```typescript
record.name // read name (QNAME)
record.start // 0-based start
record.end // 0-based exclusive end
record.CIGAR // '50M2I48M'
record.seq // read sequence
record.mq // mapping quality
record.getTag('NM') // one auxiliary tag, cheaper than record.tags
record.isReverseComplemented() // the usual SAM flags
```

- A query returns every overlapping record, unfiltered (secondary,
  supplementary, duplicate and QC-failed too), in index chunk order rather than
  coordinate order.
- Overlapping queries share records, so treat them as read-only.

[docs/api.md](docs/api.md#bamrecord) lists every field and method.

## Header and cancellation

```typescript
await bam.getHeader() // parsed SAM header
await bam.getHeaderText()

const controller = new AbortController()
await bam.getRecordsForRange('chr1', 0, 1_000_000, {
  signal: controller.signal,
  onProgress: (bytesDownloaded, totalBytes) => {},
})
```

## Performance

[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle)
merges nearby reads into one HTTP request and reuses bytes across queries:

```typescript
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'

const bam = new BamFile({
  bamFilehandle: new RemoteFileWithRangeCache(url),
  baiFilehandle: new RemoteFileWithRangeCache(`${url}.bai`),
})
```

A worker pool decompresses BGZF across threads:

```typescript
import { getSharedWorkerPool } from '@gmod/bgzf-filehandle'

const bam = new BamFile({
  bamUrl,
  baiUrl,
  bgzfWorkerPool: getSharedWorkerPool(),
})
```

- Against in-process decompression, it inflates 2.7-4.1x faster, and a pan/zoom
  over 1000x long reads ran 1.95x faster end to end
  ([measurements](docs/optimizations.md)).
- It resolves to `undefined` under node, which decompresses in-process
  ([pool size and lifecycle](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/worker-pool.md)).

## Unsorted BAM

`streamBamRecords` reads an unsorted or name-sorted BAM from start to end, an
array of records at a time ([options](docs/api.md#streambamrecords)):

```typescript
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({ bamPath: 'unsorted.bam' })) {
  for (const record of records) {
    // ...
  }
}
```

## htsget

```typescript
import { HtsgetFile } from '@gmod/bam'

const bam = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
const records = await bam.getRecordsForRange('1', 2000000, 2000001)
```

[Authentication](docs/api.md#htsgetfile) goes through its `fetch` option.

## Docs

- [docs/api.md](docs/api.md): every option, method and `BamRecord` field
- [docs/cigar-and-md.md](docs/cigar-and-md.md): what `CIGAR` and `MD` contain
- [docs/caching.md](docs/caching.md): sizing the chunk cache
- [docs/dataflow.md](docs/dataflow.md): a query from index to records
- [docs/optimizations.md](docs/optimizations.md): measurements behind the read
  path

## Academic use

Written with [NHGRI](http://genome.gov) funding as part of
[JBrowse](http://jbrowse.org). If you use this in a publication, please cite the
most recent JBrowse paper at [jbrowse.org](http://jbrowse.org).

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
