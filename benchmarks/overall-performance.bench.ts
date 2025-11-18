import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/volvox-sorted.bam'

describe('Overall Performance - Large Query', () => {
  bench('query ctgA:1-50000 and access all fields', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
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

  bench('query ctgA:1-50000 minimal access (count only)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    let count = 0
    for (const _record of records) {
      count++
    }
  })

  bench('query entire ctgA and access all fields', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 0, 1000000)
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
