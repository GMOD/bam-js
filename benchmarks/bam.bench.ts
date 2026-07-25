import { readFileSync } from 'node:fs'
import { bench, describe } from 'vitest'

import { BamFile as BamFileBranch1 } from '../esm_branch1/index.js'
import { BamFile as BamFileBranch2 } from '../esm_branch2/index.js'

const branch1Name = readFileSync('esm_branch1/branchname.txt', 'utf8').trim()
const branch2Name = readFileSync('esm_branch2/branchname.txt', 'utf8').trim()

// Every case must query a refSeq/range that actually holds records — a query
// naming a contig the file doesn't have returns [] instantly and the benchmark
// silently degrades into a getHeader() timing. Record counts are asserted in
// test/benchmark-regions.test.ts so a stale region here fails CI.
function benchBam(
  name: string,
  bamPath: string,
  refSeq: string,
  start: number,
  end: number,
  opts?: { iterations?: number; warmupIterations?: number },
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

benchBam(
  'tiny.bam (711B)',
  'test/data/tiny.bam',
  '22',
  29_999_000,
  30_001_000,
  {
    iterations: 5000,
    warmupIterations: 500,
  },
)
benchBam('samspec.bam (375B)', 'test/data/samspec.bam', 'ref', 0, 10000, {
  iterations: 5000,
  warmupIterations: 500,
})
benchBam('paired.bam (82KB)', 'test/data/paired.bam', '20', 0, 100_000, {
  iterations: 2000,
  warmupIterations: 200,
})
benchBam(
  'cho.bam (293KB)',
  'test/data/cho.bam',
  'chr1_scaffold_0',
  3_300_000,
  3_400_000,
  { iterations: 1000, warmupIterations: 100 },
)
benchBam(
  'volvox-sorted.bam (386KB)',
  'test/data/volvox-sorted.bam',
  'ctgA',
  0,
  100_000,
  { iterations: 1000, warmupIterations: 100 },
)
benchBam(
  'ecoli_nanopore.bam (1.1MB)',
  'test/data/ecoli_nanopore.bam',
  'ref000001|chr',
  0,
  5_000_000,
  { iterations: 500, warmupIterations: 25 },
)
benchBam(
  'another_chm1_id_difference.bam (1.4MB)',
  'test/data/another_chm1_id_difference.bam',
  'chr1',
  116_000_000,
  117_000_000,
  { iterations: 500, warmupIterations: 25 },
)
benchBam(
  'shortreads_300x.bam (4.9MB)',
  'test/data/shortreads_300x.bam',
  '1',
  197_700_000,
  197_800_000,
  { iterations: 500, warmupIterations: 25 },
)
benchBam(
  'chr22_nanopore_subset.bam (13MB)',
  'test/data/chr22_nanopore_subset.bam',
  '22',
  16_000_000,
  16_800_000,
  { iterations: 200, warmupIterations: 10 },
)
benchBam(
  'ultralong',
  'test/data/ultra-long-ont_hs37d5_phased.subsel.bam',
  '9',
  135_000_000,
  137_000_000,
  { iterations: 100, warmupIterations: 5 },
)
