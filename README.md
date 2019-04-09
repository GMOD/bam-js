[![Generated with nod](https://img.shields.io/badge/generator-nod-2196F3.svg?style=flat-square)](https://github.com/diegohaz/nod)
[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
[![Build Status](https://img.shields.io/travis/GMOD/bam-js/master.svg?style=flat-square)](https://travis-ci.org/GMOD/bam-js)
[![Coverage Status](https://img.shields.io/codecov/c/github/GMOD/bam-js/master.svg?style=flat-square)](https://codecov.io/gh/GMOD/bam-js/branch/master)
[![Greenkeeper badge](https://badges.greenkeeper.io/GMOD/bam-js.svg)](https://greenkeeper.io/)


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

    async read(buffer, offset = 0, length, position) // reads into buffer argument similar to fs.read
    async readFile() // returns buffer similar to fs.readFile
    async stat() // returns similar to nodejs stat

A custom filehandle could be used to read from Blob types in the browser for example

### Example

    const bam = new BAM({ bamPath: "yourfile.bam", baiPath: "yourfile.bai" })


### Documentation

#### getRecordsForRange(refName, start, end, opts)

* refName - a string for the chrom to fetch from
* start - a 0 based half open start coordinate
* end - a 0 based half open end coordinate
* opts.signal - an AbortSignal to indicate stop processing
* opts.viewAsPairs - re-dispatches requests to find mate pairs
* opts.pairAcrossChr - control the viewAsPairs option behavior to pair across chromosomes
* opts.maxInsertSize - control the viewAsPairs option behavior to limit distance within a chromosome to fetch


### Returned features

The returned features from BAM are lazy features meaning that it delays processing of all the feature tags until necessary. You can perform feature.get('field') to get the value of a feature attribute

Example

		feature.get('seq_id')
		feature.get('start')
		feature.get('name') // QNAME
		feature.get('seq') // get feature sequence

This may change in future versions to make it raw records but will be a major version bump

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
