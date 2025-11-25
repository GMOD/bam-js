import { readFileSync } from 'node:fs'
import { bench, describe } from 'vitest'

import { BamFile as BamFileBranch1 } from '../esm_branch1/index.js'
import { BamFile as BamFileBranch2 } from '../esm_branch2/index.js'

const branch1Name = readFileSync('esm_branch1/branchname.txt', 'utf8').trim()
const branch2Name = readFileSync('esm_branch2/branchname.txt', 'utf8').trim()

const bamPath = 'test/data/chr22_nanopore_subset.bam'
const refSeq = '22'
const startPosition = 16560000
const windowSize = 100
const numWindows = 5

describe('chr22_nanopore_subset.bam sliding window (5x100bp)', () => {
  bench(
    branch1Name,
    async () => {
      const bam = new BamFileBranch1({ bamPath })
      await bam.getHeader()
      for (let i = 0; i < numWindows; i++) {
        const start = startPosition + i * windowSize
        const end = start + windowSize
        await bam.getRecordsForRange(refSeq, start, end)
      }
    },
    { iterations: 10, warmupIterations: 1 },
  )

  bench(
    branch2Name,
    async () => {
      const bam = new BamFileBranch2({ bamPath })
      await bam.getHeader()
      for (let i = 0; i < numWindows; i++) {
        const start = startPosition + i * windowSize
        const end = start + windowSize
        await bam.getRecordsForRange(refSeq, start, end)
      }
    },
    { iterations: 10, warmupIterations: 1 },
  )
})
