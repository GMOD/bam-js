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
`bamPath` reads a local file, so it is node-only; in the browser pass a URL or a
generic-filehandle2 filehandle instead:

```typescript
const bam = new BamFile({
  bamUrl: 'https://example.com/yourfile.bam',
  baiUrl: 'https://example.com/yourfile.bam.bai',
})
```

Records come back unfiltered, and are shared between overlapping queries — treat
them as read-only. Filter them yourself with the flag helpers and `getTag`,
which decodes one tag instead of all of them:

```typescript
const records = (await bam.getRecordsForRange('chr1', 0, 100000)).filter(
  r => r.isProperlyPaired() && !r.isSecondary() && r.getTag('RG') === 'rg1',
)
```

## Decompressing on a worker pool

BGZF decompression is 70-90% of a cold query, and BGZF blocks are independently
inflatable. Hand `BamFile` a
[`@gmod/bgzf-filehandle`](https://github.com/GMOD/bgzf-filehandle) worker pool
and it inflates chunks there instead of on the calling thread — measured
2.7-4.1x on the pool's own fixtures.

```typescript
import { getSharedWorkerPool } from '@gmod/bgzf-filehandle'

const bam = new BamFile({
  bamUrl: 'https://example.com/yourfile.bam',
  // the pending promise is fine — it is awaited at the point of use
  bgzfWorkerPool: getSharedWorkerPool(),
})
```

No cross-origin isolation is needed. `getSharedWorkerPool()` gives back
`undefined` under node, or anywhere Workers cannot be created, which keeps the
in-process path — so this is safe to pass unconditionally. bam-js never creates
a pool on its own: the thread budget belongs to the consumer. For worker counts,
lifecycle and the pool's own benchmarks, see
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

htsget fetches the server's range as-is, so `viewAsPairs`, `pairAcrossChr` and
`maxInsertSize` are ignored. For a server that requires authentication, pass a
`fetch` that adds the bearer token:

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

Your `fetch` is called for the ticket request _and_ for the data-block urls the
ticket points at, which may live on a third-party host — so only attach
credentials to hosts you trust.

## Docs

- [docs/api.md](docs/api.md) — every constructor option, method and `BamRecord`
  field, plus custom record classes
- [docs/caching.md](docs/caching.md) — sizing the parsed-chunk cache
- [agent-docs/adr/](agent-docs/adr/) — the measurements behind the performance
  and caching decisions
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and release steps

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
