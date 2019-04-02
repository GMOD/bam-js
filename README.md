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

BAM class constructor infers BAI by default as bamPath+'.bai', or you can specify it explicitely via baiPath (also accepts csiPath)

    BAM({ bamPath: "yourfile.bam", baiPath: "yourfile.bai" })

Or accepts filehandles, this is an abstract filehandle concept that can represent remote files. The remote file concept is not built into this repository, but see @gmod/cram for example of the remoteFile.js class

    BAM({ bamFilehandle: new FileHandle("http://localhost/file.bam", baiFilehandle: new FileHandle("yourfile.bai") })



The method getRecordsForRange(refName, start, end, opts) has the opts blob that can contain


* opts.signal - an AbortSignal to indicate stop processing
* opts.viewAsPairs - re-dispatches requests to find mate pairs
* opts.pairAcrossChr - control the viewAsPairs option behavior to pair across chromosomes
* opts.maxInsertSize - control the viewAsPairs option behavior to limit distance within a chromosome to fetch

The returned features from BAM are lazy features meaning that it delays processing of all the feature tags until necessary. You can perform feature.get('field') to get the value of a feature attribute

Example

		feature.get('seq_id')
		feature.get('start')
		feature.get('name') // QNAME
		feature.get('seq') // get feature sequence

This may change in future versions to make it raw records but will be a major version bump

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
