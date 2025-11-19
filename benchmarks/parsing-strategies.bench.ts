import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/volvox-sorted.bam'

describe('Parsing Strategies', () => {
  bench('parse records - minimal access (just count)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    let count = 0
    for (const _record of records) {
      count++
    }
  })

  bench('parse records - access position only', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _start = record.start
      const _end = record.end
    }
  })

  bench('parse records - name access (string building)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _name = record.name
    }
  })

  bench('parse records - sequence access (cached, heavy)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _seq = record.seq
    }
  })

  bench('parse records - CIGAR access (cached)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _cigar = record.CIGAR
    }
  })

  bench('parse records - tags access (cached, very heavy)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    for (const record of records) {
      const _tags = record.tags
    }
  })
})

describe('Streaming vs Array', () => {
  bench('getRecordsForRange (returns array)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
    let count = 0
    for (const record of records) {
      count++
    }
  })

  bench('streamRecordsForRange (async generator)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    let count = 0
    for await (const batch of bam.streamRecordsForRange('ctgA', 1, 50000)) {
      for (const record of batch) {
        count++
      }
    }
  })
})
