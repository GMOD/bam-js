[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
[![Coverage Status](https://img.shields.io/codecov/c/github/GMOD/bam-js/master.svg?style=flat-square)](https://codecov.io/gh/GMOD/bam-js/branch/master)
[![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/bam-js/push.yml?branch=master)](https://github.com/GMOD/bam-js/actions?query=branch%3Amaster+workflow%3APush+)

## Install

```bash
$ npm install --save @gmod/bam
```

## Usage

```typescript
const { BamFile } = require('@gmod/bam')
// or import {BamFile} from '@gmod/bam'

const t = new BamFile({
  bamPath: 'test.bam',
})

// note: it's required to first run getHeader before any getRecordsForRange
var header = await t.getHeader()

// this would get same records as samtools view ctgA:1-50000
var records = await t.getRecordsForRange('ctgA', 0, 50000)
```

The `bamPath` argument only works on nodejs. In the browser, you should pass
`bamFilehandle` with a generic-filehandle2 e.g. `RemoteFile`

```typescript
const { RemoteFile } = require('generic-filehandle2')
const bam = new BamFile({
  bamFilehandle: new RemoteFile('yourfile.bam'), // or a full http url
  baiFilehandle: new RemoteFile('yourfile.bam.bai'), // or a full http url
})
```

Input are 0-based half-open coordinates (note: not the same as samtools view
coordinate inputs!)

## Usage with htsget

Since 1.0.41 we support usage of the htsget protocol

Here is a small code snippet for this

```typescript
const { HtsgetFile } = require('@gmod/bam')

const ti = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
await ti.getHeader()
const records = await ti.getRecordsForRange(1, 2000000, 2000001)
```

Our implementation makes some assumptions about how the protocol is implemented,
so let us know if it doesn't work for your use case

## Documentation

### BAM constructor

The BAM class constructor accepts arguments

- `bamPath`/`bamUrl`/`bamFilehandle` - a string file path to a local file or a
  class object with a read method
- `csiPath`/`csiUrl`/`csiFilehandle` - a CSI index for the BAM file, required
  for long chromosomes greater than 2^29 in length
- `baiPath`/`baiUrl`/`baiFilehandle` - a BAI index for the BAM file
- `recordClass` - a custom class extending BamRecord to use for records (see
  Custom BamRecord class section below)

Note: filehandles implement the Filehandle interface from
https://www.npmjs.com/package/generic-filehandle2.

This module offers the path and url arguments as convenience methods for
supplying the LocalFile and RemoteFile

### async getRecordsForRange(refName, start, end, opts)

Note: you must run getHeader before running getRecordsForRange

- `refName` - a string for the chrom to fetch from
- `start` - a 0-based half open start coordinate
- `end` - a 0-based half open end coordinate
- `opts.signal` - an AbortSignal to indicate stop processing
- `opts.viewAsPairs` - re-dispatches requests to find mate pairs. default: false
- `opts.pairAcrossChr` - control the viewAsPairs option behavior to pair across
  chromosomes. default: false
- `opts.maxInsertSize` - control the viewAsPairs option behavior to limit
  distance within a chromosome to fetch. default: 200kb

### async getHeader(opts: {....anything to pass to generic-filehandle2 opts})

This obtains the header from `HtsgetFile` or `BamFile`. Retrieves BAM file and
BAI/CSI header if applicable, or API request for refnames from htsget

### async indexCov(refName, start, end)

- `refName` - a string for the chrom to fetch from
- `start` - a 0-based half open start coordinate (optional)
- `end` - a 0-based half open end coordinate (optional)

Returns features of the form {start, end, score} containing estimated feature
density across 16kb windows in the genome

### async lineCount(refName: string)

- `refName` - a string for the chrom to fetch from

Returns number of features on refName, uses special pseudo-bin from the BAI/CSI
index (e.g. bin 37450 from bai, returning n_mapped from SAM spec pdf) or -1 if
refName not exist in sample

### async hasRefSeq(refName: string)

- `refName` - a string for the chrom to check

Returns whether we have this refName in the sample

### BamRecord properties

```typescript
// Core alignment fields
record.fileOffset // "file offset" based id -- not a true file offset
record.ref_id // numerical sequence id from SAM header
record.start // 0-based start coordinate
record.end // 0-based end coordinate
record.name // QNAME
record.seq // sequence string
record.qual // Uint8Array of quality scores (null if unmapped)
record.CIGAR // CIGAR string e.g. "50M2I48M"
record.flags // SAM flags integer
record.mq // mapping quality (undefined if 255)
record.strand // 1 or -1
record.template_length // TLEN

// Auxiliary data
record.tags // object with all aux tags e.g. {MD: "100", NM: 0}
record.NUMERIC_MD // MD tag as Uint8Array (for fast mismatch rendering)
record.NUMERIC_CIGAR // Uint32Array of packed CIGAR operations
record.NUMERIC_SEQ // Uint8Array of packed sequence (4-bit encoded)

// Mate info
record.next_refid // mate reference id
record.next_pos // mate position

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
record.seqAt(idx) // get single base at position
record.toJSON() // serialize record
```

### Custom BamRecord class

You can provide your own BamRecord class to add custom properties or methods:

```typescript
import { BamFile, BamRecord } from '@gmod/bam'

class CustomBamRecord extends BamRecord {
  get customProperty() {
    return `custom-${this.name}`
  }

  getDoubleStart() {
    return this.start * 2
  }
}

const bam = new BamFile<CustomBamRecord>({
  bamPath: 'test.bam',
  recordClass: CustomBamRecord,
})

await bam.getHeader()
const records = await bam.getRecordsForRange('ctgA', 0, 50000)
// records are typed as CustomBamRecord[]
console.log(records[0].customProperty)
console.log(records[0].getDoubleStart())
```

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
