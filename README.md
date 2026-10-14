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
  console.log(record.name, record.start, record.CIGAR)
}
```

URLs work in node and the browser, and local files take `bamPath` and `baiPath`
instead.

### Range caching

bam-js fetches the index once, then reads each query's records as a few byte
ranges spread through the BAM. With `bamUrl`, bam-js sends a separate HTTP
request for each range.
[This visualizer](https://cmdcolin.github.io/bam_index_visualizer) draws those
ranges for a file of your choosing.
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle)
fetches the file in 256 KiB chunks and answers each range from them, so it
fetches neighboring ranges in one request and answers later queries from chunks
it already has:

```typescript
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'

const bam = new BamFile({
  bamFilehandle: new RemoteFileWithRangeCache(url),
  baiFilehandle: new RemoteFileWithRangeCache(`${url}.bai`),
})
```

## Coordinates

Coordinates are 0-based half-open, where `samtools view` takes 1-based closed,
so `samtools view file.bam ctgA:1-50000` returns the same records as
`getRecordsForRange('ctgA', 0, 50000)`. A query for a reference the file lacks
returns `[]`.

## Records

```typescript
record.name // read name
record.start // 0-based start
record.CIGAR // '50M2I48M'
record.seq // read sequence
record.getTag('NM') // one auxiliary tag
record.isReverseComplemented() // the usual SAM flags
```

Queries return records unfiltered, and overlapping queries share them, so treat
them as read-only. `getTag` decodes one tag instead of all of them, which makes
it the cheap way to filter:

```typescript
const records = (await bam.getRecordsForRange('chr1', 0, 100000)).filter(
  r => r.isProperlyPaired() && !r.isSecondary() && r.getTag('RG') === 'rg1',
)
```

[docs/api.md](docs/api.md#bamrecord) lists every field and method.

## Mismatches

`record.getMismatches()` lists each difference between a read and the reference:
substitutions, insertions, deletions, reference skips and clips.

```typescript
// a read at 100 with CIGAR 5M1I4M2D3M, SEQ ACGGTCAACGTTA and MD 3A5^GG3
for (const { code, refPos, length, bases } of record.getMismatches()) {
  console.log(String.fromCharCode(code), refPos, length, bases)
}
// X 103 1 G   substitution to G
// I 105 0 C   one base inserted before 105
// D 109 2     two reference bases deleted from 109
```

A substitution needs the read's `MD` tag or the reference bases. Most aligners
leave `MD` off, so pass `fetchReferenceSequence: (refName, start, end) => ...`
to `BamFile`. bam-js calls it only for a query with a read that lacks `MD`.
[docs/api.md](docs/api.md#mismatches) has the fields and options.

## Worker pool

BGZF blocks decompress independently, so a worker pool can spread decompression
across threads, which measured 2.7-4.1x faster on the pool's own fixtures:

```typescript
import { getSharedWorkerPool } from '@gmod/bgzf-filehandle'

const bam = new BamFile({
  bamUrl,
  baiUrl,
  bgzfWorkerPool: getSharedWorkerPool(),
})
```

`getSharedWorkerPool()` returns a promise of the pool, which bam-js awaits when
it first decompresses. The pool is `undefined` under node and wherever the host
forbids workers, and bam-js then decompresses in-process, so the option is safe
to pass everywhere. The pool needs no cross-origin isolation, and bam-js never
starts one itself.
[bgzf-filehandle's docs](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/worker-pool.md)
cover pool size and lifecycle.

## Unsorted BAM

An unsorted or name-sorted BAM has no index to query, so `streamBamRecords`
reads it from start to end, an array of records at a time:

```typescript
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({ bamUrl: 'unsorted.bam' })) {
  for (const record of records) {
    // ...
  }
}
```

[docs/api.md](docs/api.md#streambamrecords) has the options.

## htsget

```typescript
import { HtsgetFile } from '@gmod/bam'

const bam = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
const records = await bam.getRecordsForRange('1', 2000000, 2000001)
```

[docs/api.md](docs/api.md#htsgetfile) shows how to add authentication.

## Docs

- [docs/api.md](docs/api.md): every option, method and `BamRecord` field
- [docs/cigar-and-md.md](docs/cigar-and-md.md): what `CIGAR` and `MD` contain,
  and how the mismatch walk reads them
- [docs/caching.md](docs/caching.md): sizing the chunk cache
- [docs/dataflow.md](docs/dataflow.md): a diagram of a query from index to
  records
- [docs/optimizations.md](docs/optimizations.md): the measurements behind the
  read path's design
- [agent-docs/architecture-decision-records/](agent-docs/architecture-decision-records/):
  design decisions, with their measurements
- [CONTRIBUTING.md](CONTRIBUTING.md): development and release

## Academic use

Written with [NHGRI](http://genome.gov) funding as part of
[JBrowse](http://jbrowse.org). If you use this in a publication, please cite the
most recent JBrowse paper at [jbrowse.org](http://jbrowse.org).

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
