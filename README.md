[![Generated with nod](https://img.shields.io/badge/generator-nod-2196F3.svg?style=flat-square)](https://github.com/diegohaz/nod)
[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
[![Build Status](https://img.shields.io/travis/GMOD/bam-js/master.svg?style=flat-square)](https://travis-ci.org/GMOD/bam-js)
[![Coverage Status](https://img.shields.io/codecov/c/github/GMOD/bam-js/master.svg?style=flat-square)](https://codecov.io/gh/GMOD/bam-js/branch/master)

## Install

    $ npm install --save @gmod/bam

## Usage

```js
const { BamFile } = require('@gmod/bam') // or import {BamFile} from '@gmod/bam'

const t = new BamFile({
  bamPath: 'test.bam',
})

var header = await t.getHeader()

// this would get same records as samtools view ctgA:1-50000
var records = await t.getRecordsForRange('ctgA', 0, 49999)
```

Input are 0-based half-open coordinates (note: not the same as samtools view coordinate inputs!)

## Usage with htsget

Since 1.0.41 we support htsget!

Here is a small code snippet for this

```js
const { HtsgetFile } = require('@gmod/bam')

const ti = new HtsgetFile({
  baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
  trackId: 'BroadHiSeqX_b37/NA12878',
})
await ti.getHeader()
const records = await ti.getRecordsForRange(1, 2000000, 2000001)
```

## Documentation

### BAM constructor

The BAM class constructor accepts arguments

- bamPath/baiUrl/bamFilehandle - a string file path to a local file or a class object with a read method
- csiPath/csiUrl/csiFilehandle - a CSI index for the BAM file, required for long chromosomes greater than 2^29 in length
- baiPath/baiUrl/baiFilehandle - a BAI index for the BAM file
- fetchSizeLimit - total size of the number of chunks being fetched at once. default: ~50MB
- chunkSizeLimit - size limit on any individual chunk. default: ~10MB
- cacheSize - limit on number of chunks to cache. default: 50
- yieldThreadTime - the interval at which the code yields to the main thread when it is parsing a lot of data. default: 100ms. Set to 0 to performed no yielding

Note: filehandles implement the Filehandle interface from https://www.npmjs.com/package/generic-filehandle. This module offers the path and url arguments as convenience methods for supplying the LocalFile and RemoteFile

### async getRecordsForRange(refName, start, end, opts)

- refName - a string for the chrom to fetch from
- start - a 0 based half open start coordinate
- end - a 0 based half open end coordinate
- opts.signal - an AbortSignal to indicate stop processing
- opts.viewAsPairs - re-dispatches requests to find mate pairs. default: false
- opts.pairAcrossChr - control the viewAsPairs option behavior to pair across chromosomes. default: false
- opts.maxInsertSize - control the viewAsPairs option behavior to limit distance within a chromosome to fetch. default: 200kb

### async \*streamRecordsForRange(refName, start, end, opts)

This is a async generator function that takes the same signature as getRecordsForRange but results can be processed using

    for await(const chunk of file.streamRecordsForRange(refName, start, end, opts)) {
    }

The getRecordsForRange simply wraps this process by concatenating chunks into an array

### async getHeader(opts: {....anything to pass to generic-filehandle opts})

This obtains the header from HtsgetFile or BamFile. Retrieves BAM file and BAI/CSI header if applicable, or API request for refnames from htsget

### async indexCov(refName, start, end)

- refName - a string for the chrom to fetch from
- start - a 0 based half open start coordinate (optional)
- end - a 0 based half open end coordinate (optional)

Returns features of the form {start, end, score} containing estimated feature density across 16kb windows in the genome

### async lineCount(refName)

- refName - a string for the chrom to fetch from

Returns number of features on refName, uses special pseudo-bin from the BAI/CSI index (e.g. bin 37450 from bai, returning n_mapped from SAM spec pdf) or -1 if refName not exist in sample

### async hasRefSeq(refName)

- refName - a string for the chrom to check

Returns whether we have this refName in the sample

### Returned features

The returned features from BAM are lazy features meaning that it delays
processing of all the feature tags until necessary.

You can access data feature.get('field') to get the value of a feature attribute

Example

    feature.get('seq_id') // numerical sequence id corresponding to position in the sam header
    feature.get('start') // 0 based half open start coordinate
    feature.get('end') // 0 based half open end coordinate

#### Fields

    feature.get('name') // QNAME
    feature.get('seq') // feature sequence
    feature.get('qual') // qualities
    feature.get('cigar') // cigar string
    feature.get('MD') // MD string
    feature.get('SA') // supplementary alignments
    feature.get('template_length') // TLEN
    feature.get('length_on_ref') // derived from CIGAR using standard algorithm

#### Flags

    feature.get('flags') // see https://broadinstitute.github.io/picard/explain-flags.html

#### Tags

BAM tags such as MD can be obtained via

    feature.get('MD')

A full list of tags that can be obtained can be obtained via

    feature._tags()

The feature format may change in future versions to be more raw data records, but this will be a major version bump

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)

```

```
