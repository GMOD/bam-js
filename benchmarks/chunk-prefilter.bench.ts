import { bench, describe } from 'vitest'
import BamFile from '../esm/bamFile.js'

describe('Chunk Pre-filtering Optimization', () => {
  const bam = new BamFile({
    bamPath: './test/data/out.bam',
    baiPath: './test/data/out.bam.bai',
  })

  bench(
    'Small range query (1:1-1000) - many records filtered',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 1000)
      for (const record of records) {
        const _seq = record.seq
        const _cigar = record.CIGAR
      }
    },
    { iterations: 100 },
  )

  bench(
    'Medium range query (1:1-10000)',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 10000)
      for (const record of records) {
        const _seq = record.seq
        const _cigar = record.CIGAR
      }
    },
    { iterations: 50 },
  )

  bench(
    'Large range query (1:1-100000)',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 100000)
      for (const record of records) {
        const _seq = record.seq
        const _cigar = record.CIGAR
      }
    },
    { iterations: 25 },
  )

  bench(
    'Access all fields (1:1-10000)',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 10000)
      for (const record of records) {
        const _start = record.start
        const _end = record.end
        const _strand = record.strand
        const _name = record.name
        const _cigar = record.CIGAR
        const _seq = record.seq
        const _qual = record.qual
        const _tags = record.tags
      }
    },
    { iterations: 50 },
  )
})
