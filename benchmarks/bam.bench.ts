import { readFileSync } from 'node:fs'
import { bench, describe } from 'vitest'

import { BamFile as BamFileBranch1 } from '../esm_branch1/index.js'
import { BamFile as BamFileBranch2 } from '../esm_branch2/index.js'

const branch1Name = readFileSync('esm_branch1/branchname.txt', 'utf8').trim()
const branch2Name = readFileSync('esm_branch2/branchname.txt', 'utf8').trim()

function benchBam(
  name: string,
  bamPath: string,
  refSeq: string,
  start: number,
  end: number,
  opts?: { time?: number },
) {
  describe(name, () => {
    bench(
      branch1Name,
      async () => {
        const bam = new BamFileBranch1({ bamPath })
        await bam.getHeader()
        await bam.getRecordsForRange(refSeq, start, end)
      },
      opts,
    )

    bench(
      branch2Name,
      async () => {
        const bam = new BamFileBranch2({ bamPath })
        await bam.getHeader()
        await bam.getRecordsForRange(refSeq, start, end)
      },
      opts,
    )
  })
}

benchBam('tiny.bam (711B)', 'test/data/tiny.bam', 'ctgA', 0, 1000, {
  time: 8000,
})
benchBam('samspec.bam (375B)', 'test/data/samspec.bam', 'ref', 0, 10000, {
  time: 8000,
})
benchBam('paired.bam (82KB)', 'test/data/paired.bam', 'ctgA', 0, 100000, {
  time: 8000,
})
benchBam('cho.bam (293KB)', 'test/data/cho.bam', 'chr10', 0, 1000000, {
  time: 8000,
})
benchBam(
  'volvox-sorted.bam (386KB)',
  'test/data/volvox-sorted.bam',
  'ctgA',
  0,
  100000,
  { time: 8000 },
)
benchBam(
  'ecoli_nanopore.bam (1.1MB)',
  'test/data/ecoli_nanopore.bam',
  'ref000001',
  0,
  5000000,
  { time: 8000 },
)
benchBam(
  'another_chm1_id_difference.bam (1.4MB)',
  'test/data/another_chm1_id_difference.bam',
  'chr20',
  0,
  100000000,
  { time: 8000 },
)
benchBam(
  'shortreads_300x.bam (4.9MB)',
  'test/data/shortreads_300x.bam',
  'ctgA',
  0,
  100000,
  { time: 8000 },
)
benchBam(
  'chr22_nanopore_subset.bam (13MB)',
  'test/data/chr22_nanopore_subset.bam',
  'chr22',
  0,
  100000000,
  { time: 8000 },
)
benchBam(
  'ultralong',
  'test/data/ultra-long-ont_hs37d5_phased.subsel.bam',
  '9',
  0,
  226_105_551,
  { time: 8000 },
)
