# @gmod/bam

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

Coordinates are 0-based half-open, where `samtools view` takes 1-based closed —
`ctgA:1-50000` there is `('ctgA', 0, 50000)` here. `bamPath` reads a local file,
so it is node-only; in the browser pass a URL or a generic-filehandle2
filehandle instead:

```typescript
const bam = new BamFile({
  bamUrl: 'https://example.com/yourfile.bam',
  baiUrl: 'https://example.com/yourfile.bam.bai',
})
```

Over HTTP it is worth putting
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle)
underneath the filehandle. It caches what it reads in 256 KiB chunks and turns
the chunks a read is missing into one request per contiguous run, so the
scattered index and data reads a query makes arrive as a couple of fetches
rather than dozens. `bamFilehandle` and `baiFilehandle` accept any
generic-filehandle2 object, so it drops straight in:

```typescript
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'

const bam = new BamFile({
  bamFilehandle: new RemoteFileWithRangeCache(url),
  baiFilehandle: new RemoteFileWithRangeCache(`${url}.bai`),
})
```

Records come back unfiltered, and overlapping queries share them — treat them as
read-only. Filter them yourself with the flag helpers and `getTag`, which
decodes one tag instead of all of them:

```typescript
const records = (await bam.getRecordsForRange('chr1', 0, 100000)).filter(
  r => r.isProperlyPaired() && !r.isSecondary() && r.getTag('RG') === 'rg1',
)
```

## Unsorted BAM

A BAM that is unsorted, or still name-sorted as it came off the sequencer, has
no index to query and so no `chr:start-end` to query it with. `streamBamRecords`
walks one end to end instead, a batch of records at a time:

```typescript
import { streamBamRecords } from '@gmod/bam'

for await (const records of streamBamRecords({ bamUrl: 'unsorted.bam' })) {
  for (const record of records) {
    // ...
  }
}
```

It reads the file a window at a time rather than all at once, so a 1GB BAM
streams through in bounded memory. A standalone function rather than a `BamFile`
method, so that streaming alone leaves `BAI`/`CSI` and the chunk cache out of
your bundle. See [docs/api.md](docs/api.md) for `onHeader` and the window size.

## Mismatches

`record.getMismatches()` gives every difference between a read and the reference
— substitutions, insertions, deletions, reference skips and clips — without you
interpreting `CIGAR` and `MD` yourself:

```typescript
const bam = new BamFile({
  bamPath: 'test.bam',
  // reference bases for reads with no MD tag, at most one call per query
  fetchReferenceSequence: (refName, start, end) =>
    myGenome.getSequence(refName, start, end),
})

for (const record of await bam.getRecordsForRange('ctgA', 0, 50000)) {
  // for a read at 100 with CIGAR 5M1I4M2D3M, SEQ ACGGTCAACGTTA, MD 3A5^GG3
  for (const { code, refPos, length, bases } of record.getMismatches()) {
    console.log(String.fromCharCode(code), refPos, length, bases)
  }
}
// X 103 1 G   substitution to G, over a reference A
// I 105 0 C   one base inserted before 105
// D 109 2     two reference bases deleted from 109
```

`code` is a CIGAR char code, to compare against the exported `MISMATCH_SUBST`,
`MISMATCH_INSERTION`, … constants, and `record.forEachMismatch(cb, opts?)`
reports the same set while allocating nothing per difference. What those two
fields say, with that read walked through them:
[docs/cigar-and-md.md](docs/cigar-and-md.md).

Substitutions need either an `MD` tag on the read or the reference bases, which
is what `fetchReferenceSequence` is doing above — most aligners leave `MD` off,
and a query calls it only when one of its reads needs it. Without it, a read
lacking `MD` still reports its indels and clips but no substitutions — nothing
in the record says where they are. [docs/api.md](docs/api.md#mismatches) has the
field meanings, and what to do about reads that run past the region you are
looking at.

## How a query flows

A query turns the region into BGZF chunks through the index and decompresses
each one in wasm. With nothing cached yet, decompression takes 70-90% of the
time that query needs. The rest is ordinary JS: records are views into their
chunk's decompressed buffer, and their fields decode on access, so a query costs
what you read off it. [docs/dataflow.md](docs/dataflow.md) has the diagram and
walks it through.

The file then holds on to those decompressed chunks, so overlapping and adjacent
queries reuse them instead of inflating again — up to 1GB per file, dropped
after three idle minutes. A consumer holding one file per track should bound
them together with a shared `cacheBudget` rather than shrinking each file's own
ceiling: [docs/caching.md](docs/caching.md).

## Decompressing on a worker pool

BGZF blocks inflate independently, so that decompression can spread across
threads — measured 2.7-4.1x on the pool's own fixtures.

```typescript
import { getSharedWorkerPool } from '@gmod/bgzf-filehandle'

const bam = new BamFile({
  bamUrl: 'https://example.com/yourfile.bam',
  // the pending promise is fine — it is awaited at the point of use
  bgzfWorkerPool: getSharedWorkerPool(),
})
```

Safe to pass unconditionally: `getSharedWorkerPool()` returns `undefined` under
node, or anywhere the host forbids Workers, which keeps the in-process path. No
cross-origin isolation needed. bam-js never creates a pool on its own — the
thread budget belongs to the consumer. Worker counts, lifecycle and benchmarks:
[bgzf-filehandle's worker pool docs](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/worker-pool.md).

## Usage with htsget

```typescript
import { HtsgetFile } from '@gmod/bam'

const bam = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
const records = await bam.getRecordsForRange('1', 2000000, 2000001)
```

htsget fetches the server's range as-is, so it ignores the mate-pairing options.
Pass a `fetch` to add auth:

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

That `fetch` serves the ticket request _and_ the data-block urls the ticket
points at, which may live on a third-party host — so only attach credentials to
hosts you trust.

## Docs

- [docs/api.md](docs/api.md) — every constructor option, method and `BamRecord`
  field, plus custom record classes
- [docs/cigar-and-md.md](docs/cigar-and-md.md) — what `CIGAR` and `MD` say, and
  how the walk reads mismatches out of them
- [docs/dataflow.md](docs/dataflow.md) — how a query flows, and where wasm sits
- [docs/optimizations.md](docs/optimizations.md) — why each step of that path
  looks the way it does, and what measured it
- [docs/caching.md](docs/caching.md) — sizing the parsed-chunk cache
- [agent-docs/adr/](agent-docs/adr/) — the measurements behind the performance
  and caching decisions
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and release steps

## Academic Use

Written with [NHGRI](http://genome.gov) funding as part of
[JBrowse](http://jbrowse.org). If you use this in a publication, please cite the
most recent JBrowse paper at [jbrowse.org](http://jbrowse.org).

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
