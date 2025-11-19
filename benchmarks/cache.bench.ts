import { bench, describe } from 'vitest'
import BamFile from '../src/bamFile.ts'

const bamPath = './test/data/volvox-sorted.bam'

describe('Cache Performance - Repeated Queries', () => {
  bench('with cache enabled', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    await bam.getHeader()
    // Query the same region multiple times to show cache benefit
    for (let i = 0; i < 5; i++) {
      await bam.getRecordsForRange('ctgA', 1, 50000)
    }
  })

  bench('without cache', async () => {
    const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
    bam.cache.clear()
    Object.defineProperty(bam.cache, 'set', {
      value: () => {},
      writable: false,
    })
    await bam.getHeader()
    // Query the same region multiple times
    for (let i = 0; i < 5; i++) {
      await bam.getRecordsForRange('ctgA', 1, 50000)
    }
  })
})

describe('Overlapping Regions Cache Performance', () => {
  bench(
    'overlapping queries with cache',
    async () => {
      const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
      await bam.getHeader()
      for (let i = 0; i < 20; i++) {
        await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
      }
    },
    { iterations: 5 },
  )

  bench(
    'overlapping queries without cache',
    async () => {
      const bam = new BamFile({ bamPath, baiPath: `${bamPath}.bai` })
      bam.cache.clear()
      Object.defineProperty(bam.cache, 'set', {
        value: () => {},
        writable: false,
      })
      await bam.getHeader()
      for (let i = 0; i < 20; i++) {
        await bam.getRecordsForRange('ctgA', 1000 + i * 1000, 5000 + i * 1000)
      }
    },
    { iterations: 5 },
  )
})
