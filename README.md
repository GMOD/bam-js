[![Generated with nod](https://img.shields.io/badge/generator-nod-2196F3.svg?style=flat-square)](https://github.com/diegohaz/nod)
[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
[![Build Status](https://img.shields.io/travis/GMOD/bam-js/master.svg?style=flat-square)](https://travis-ci.org/GMOD/bam-js)
[![Coverage Status](https://img.shields.io/codecov/c/github/GMOD/bam-js/master.svg?style=flat-square)](https://codecov.io/gh/GMOD/bam-js/branch/master)


## Install

    $ npm install --save @gmod/bam

## Usage

```js
const {BamFile} = require('@gmod/bam');

const t = new BamFile({
    bamPath: 'test.bam',
});

var header = await t.getHeader()

var records = await t.getRecordsForRange('ctgA', 1, 50000)
```

Input are 0-based half-open coordinates (note: not the same as samtools view coordinate inputs!)

## Documentation


### BAM constructor


The BAM class constructor accepts arguments

* bamPath/bamFilehandle - a string file path to a local file or a class object with a read method
* csiPath/csiFilehandle - a CSI index for the BAM file, required for long chromosomes greater than 2^29 in length
* baiPath/baiFilehandle - a BAI index for the BAM file
* fetchSizeLimit - total size of the number of chunks being fetched at once. default: ~50MB
* chunkSizeLimit - size limit on any individual chunk. default: ~10MB
* cacheSize - limit on number of chunks to cache. default: 50

### Implementing your filehandle class

If using the filehandle class, should implement

    async read(buffer, offset = 0, length, position) // reads into buffer argument similar to fs.read, returns number of bytes read
    async readFile() // returns buffer similar to fs.readFile
    async stat() // returns similar to nodejs stat

A custom filehandle could be used to read from Blob types in the browser for example


### Documentation

#### getRecordsForRange(refName, start, end, opts)

* refName - a string for the chrom to fetch from
* start - a 0 based half open start coordinate
* end - a 0 based half open end coordinate
* opts.signal - an AbortSignal to indicate stop processing
* opts.viewAsPairs - re-dispatches requests to find mate pairs. default: false
* opts.pairAcrossChr - control the viewAsPairs option behavior to pair across chromosomes. default: false
* opts.maxInsertSize - control the viewAsPairs option behavior to limit distance within a chromosome to fetch. default: 200kb

### indexCov(refName, start, end)

* refName - a string for the chrom to fetch from
* start - a 0 based half open start coordinate (optional, will fetch whole chromosome without)
* end - a 0 based half open end coordinate (optional, will fetch whole chromosome without even if start is specified)

Returns features of the form {start, end, score} containing estimated feature density across 16kb windows in the genome

### Returned features

The returned features from BAM are lazy features meaning that it delays processing of all the feature tags until necessary.

You can access data feature.get('field') to get the value of a feature attribute

Example

    feature.get('seq_id') // numerical sequence id corresponding to position in the sam header
    feature.get('start') // 0 based half open start coordinate
    feature.get('end') // 0 based half open end coordinate

## Fields

    feature.get('name') // QNAME
    feature.get('seq') // feature sequence
    feature.get('qual') // qualities
    feature.get('cigar') // cigar string
    feature.get('MD') // MD string
    feature.get('SA') // supplementary alignments
    feature.get('template_length') // TLEN
    feature.get('length_on_ref') // derived from CIGAR using standard algorithm

### Flags

    feature.get('seq_reverse_complemented')
    feature.get('unmapped')
    feature.get('qc_failed')
    feature.get('duplicate')
    feature.get('secondary_alignment')
    feature.get('supplementary_alignment')

The feature format may change in future versions to be more raw records but will be a major version bump

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
