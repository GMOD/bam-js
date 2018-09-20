[![Generated with nod](https://img.shields.io/badge/generator-nod-2196F3.svg?style=flat-square)](https://github.com/diegohaz/nod)
[![NPM version](https://img.shields.io/npm/v/@gmod/bam.svg?style=flat-square)](https://npmjs.org/package/@gmod/bam)
[![Build Status](https://img.shields.io/travis/GMOD/bam-js/master.svg?style=flat-square)](https://travis-ci.org/GMOD/bam-js) [![Coverage Status](https://img.shields.io/codecov/c/github/GMOD/bam-js/master.svg?style=flat-square)](https://codecov.io/gh/GMOD/bam-js/branch/master)


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

Input are 1-based closed coordinates (e.g. same as samtools view coordinate inputs)


## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
