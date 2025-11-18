import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/volvox-sorted.bam'

describe('Field Access Patterns', () => {
  bench('access basic fields only (start, end, strand)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _s = record.start
      const _e = record.end
      const _strand = record.strand
    }
  })

  bench('access CIGAR (cached getter)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _cigar = record.CIGAR
    }
  })

  bench('access sequence (cached getter)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _seq = record.seq
    }
  })

  bench('access tags (cached getter)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _tags = record.tags
    }
  })

  bench('access all common fields', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _s = record.start
      const _e = record.end
      const _strand = record.strand
      const _name = record.name
      const _cigar = record.CIGAR
      const _seq = record.seq
      const _qual = record.qual
      const _tags = record.tags
    }
  })
})
