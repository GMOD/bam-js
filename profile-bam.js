import { BamFile } from './esm/index.js'

const bam = new BamFile({
  bamPath: 'test/data/ultra-long-ont_hs37d5_phased.subsel.bam',
})
await bam.getHeader()
await bam.getRecordsForRange('9', 0, 226_105_551)
