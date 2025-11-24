import { bench, describe } from 'vitest'

import { BamFile as BamFileMaster } from '../esm_master/index.js'
import { BamFile as BamFileOptimized } from '../esm_thisbranch/index.js'

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
      'master',
      async () => {
        const bam = new BamFileMaster({ bamPath })
        await bam.getHeader()
        await bam.getRecordsForRange(refSeq, start, end)
      },
      opts,
    )

    bench(
      'optimized',
      async () => {
        const bam = new BamFileOptimized({ bamPath })
        await bam.getHeader()
        await bam.getRecordsForRange(refSeq, start, end)
      },
      opts,
    )
  })
}

benchBam('tiny.bam (711B)', 'test/data/tiny.bam', 'ctgA', 0, 1000)
benchBam('samspec.bam (375B)', 'test/data/samspec.bam', 'ref', 0, 10000)
benchBam('paired.bam (82KB)', 'test/data/paired.bam', 'ctgA', 0, 100000)
benchBam('cho.bam (293KB)', 'test/data/cho.bam', 'chr10', 0, 1000000)
benchBam(
  'volvox-sorted.bam (386KB)',
  'test/data/volvox-sorted.bam',
  'ctgA',
  0,
  100000,
)
benchBam(
  'ecoli_nanopore.bam (1.1MB)',
  'test/data/ecoli_nanopore.bam',
  'ref000001',
  0,
  5000000,
)
benchBam(
  'another_chm1_id_difference.bam (1.4MB)',
  'test/data/another_chm1_id_difference.bam',
  'chr20',
  0,
  100000000,
)
benchBam(
  'shortreads_300x.bam (4.9MB)',
  'test/data/shortreads_300x.bam',
  'ctgA',
  0,
  100000,
)
benchBam(
  'chr22_nanopore_subset.bam (13MB)',
  'test/data/chr22_nanopore_subset.bam',
  'chr22',
  0,
  100000000,
)
benchBam(
  'ultralong',
  'test/data/ultra-long-ont_hs37d5_phased.subsel.bam',
  '9',
  0,
  226_105_551,
  { time: 10000 },
)
