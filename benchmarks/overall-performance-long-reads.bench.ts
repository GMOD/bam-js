import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/out.bam'
const chr = '1'

describe('Overall Performance - Long Reads', () => {
  bench('query 1:1-100000 and access all fields', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(chr, 1, 100000)
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
  })

  bench('query 1:1-100000 minimal access (count only)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(chr, 1, 100000)
    let count = 0
    for (const _record of records) {
      count++
    }
  })

  bench('query 1:1-100000 and access sequence only', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(chr, 1, 100000)
    for (const record of records) {
      const _seq = record.seq
    }
  })

  bench('query 1:1-100000 and access tags only', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(chr, 1, 100000)
    for (const record of records) {
      const _tags = record.tags
    }
  })

  bench('query 1:1-500000 and access all fields', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(chr, 1, 500000)
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
  })
})
