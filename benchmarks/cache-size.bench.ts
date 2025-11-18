import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/volvox-sorted.bam'

describe('Cache Size Tuning', () => {
  bench('maxSize: 100', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    bam.cache = new (await import('quick-lru')).default({ maxSize: 100 })
    await bam.getHeader()
    for (let i = 0; i < 20; i++) {
      await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
    }
  })

  bench('maxSize: 500', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    bam.cache = new (await import('quick-lru')).default({ maxSize: 500 })
    await bam.getHeader()
    for (let i = 0; i < 20; i++) {
      await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
    }
  })

  bench('maxSize: 1000 (current)', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    for (let i = 0; i < 20; i++) {
      await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
    }
  })

  bench('maxSize: 2000', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    bam.cache = new (await import('quick-lru')).default({ maxSize: 2000 })
    await bam.getHeader()
    for (let i = 0; i < 20; i++) {
      await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
    }
  })

  bench('maxSize: 5000', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    bam.cache = new (await import('quick-lru')).default({ maxSize: 5000 })
    await bam.getHeader()
    for (let i = 0; i < 20; i++) {
      await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
    }
  })
})
