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

Local files take `bamPath` and `baiPath`. Substitutions inside `M` runs need
more setup, see [Mismatches](#mismatches).

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
letter without allocating a small string, since V8 returns an interned
single-character string. bam-js builds `CIGAR` the same way, 1.13x faster than a
lookup table of letters.

A substitution inside an `M` run needs the read's `MD` tag or the reference
bases. Most aligners omit `MD`, so pass
`fetchReferenceSequence: (refName, start, end) => ...` to `BamFile`, which
bam-js calls only for a query with a read that lacks `MD`.
[docs/api.md](docs/api.md#mismatches) has the fields and options.

## Coordinates

Coordinates are 0-based half-open, where `samtools view` takes 1-based closed,
so `samtools view file.bam ctgA:1-50000` returns the same records as
`getRecordsForRange('ctgA', 0, 50000)`. A query for a reference the file lacks
returns `[]`.

## Records

A record is one alignment, a line of `samtools view`. Each `BamRecord` decodes a
field only when you read it.

```typescript
record.name // read name (QNAME)
record.start // 0-based start
record.end // 0-based exclusive end
record.CIGAR // '50M2I48M'
record.seq // read sequence
record.mq // mapping quality
record.getTag('NM') // one auxiliary tag
record.isReverseComplemented() // the usual SAM flags
record.getMismatches() // differences from the reference
```

- A query returns every record that overlaps the range, including ones that
  start before or end after it.
- Records are unfiltered: secondary, supplementary, duplicate and QC-failed
  reads come back too.
- Records arrive in index chunk order, not coordinate order.
- Overlapping queries share records, so treat them as read-only.

`getTag` decodes one tag, which makes it the cheap way to filter:

```typescript
const records = (await bam.getRecordsForRange('chr1', 0, 100000)).filter(
  r => r.isProperlyPaired() && !r.isSecondary() && r.getTag('RG') === 'rg1',
)
```

[docs/api.md](docs/api.md#bamrecord) lists every field and method.

## Range caching

With `bamUrl`, each byte range a query reads is a separate HTTP request
([visualizer](https://cmdcolin.github.io/bam_index_visualizer)).
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle)
merges nearby reads into one request and reuses bytes across queries:

```typescript
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'

const bam = new BamFile({
  bamFilehandle: new RemoteFileWithRangeCache(url),
  baiFilehandle: new RemoteFileWithRangeCache(`${url}.bai`),
})
```

## Worker pool

A worker pool decompresses BGZF across threads. Relative to decompressing
in-process, it inflates 2.7-4.1x faster at eight workers, and a 22-view pan/zoom
over 1000x long reads ran 1.95x faster end to end at four
([measurements](docs/optimizations.md)):

```typescript
import { getSharedWorkerPool } from '@gmod/bgzf-filehandle'

const bam = new BamFile({
  bamUrl,
  baiUrl,
  bgzfWorkerPool: getSharedWorkerPool(),
})
```

The pool is `undefined` under node or where workers are forbidden, and bam-js
then decompresses in-process. See
[bgzf-filehandle's docs](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/worker-pool.md)
for pool size and lifecycle.

## Unsorted BAM

`streamBamRecords` reads an unsorted or name-sorted BAM from start to end, an
array of records at a time:

```typescript
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({ bamPath: 'unsorted.bam' })) {
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

## Academic use

Written with [NHGRI](http://genome.gov) funding as part of
[JBrowse](http://jbrowse.org). If you use this in a publication, please cite the
most recent JBrowse paper at [jbrowse.org](http://jbrowse.org).

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
