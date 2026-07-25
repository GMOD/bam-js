import { expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'

// Keep benchmarks/bam.bench.ts honest. A benchmark naming a contig the file
// doesn't have returns [] before touching the BGZF or record code, so it stays
// green while measuring nothing but getHeader(). Seven of the ten cases were in
// that state before these were pinned.
const REGIONS: [string, string, number, number, number][] = [
  ['tiny.bam', '22', 29_999_000, 30_001_000, 2],
  ['samspec.bam', 'ref', 0, 10_000, 6],
  ['paired.bam', '20', 0, 100_000, 732],
  ['cho.bam', 'chr1_scaffold_0', 3_300_000, 3_400_000, 21],
  ['volvox-sorted.bam', 'ctgA', 0, 100_000, 9596],
  ['ecoli_nanopore.bam', 'ref000001|chr', 0, 5_000_000, 480],
  ['another_chm1_id_difference.bam', 'chr1', 116_000_000, 117_000_000, 204],
  ['shortreads_300x.bam', '1', 197_700_000, 197_800_000, 53_596],
  ['chr22_nanopore_subset.bam', '22', 16_000_000, 16_800_000, 757],
  [
    'ultra-long-ont_hs37d5_phased.subsel.bam',
    '9',
    135_000_000,
    137_000_000,
    75,
  ],
]

test.each(REGIONS)(
  '%s benchmark region %s:%i-%i yields %i records',
  async (file, refName, start, end, expected) => {
    const bam = new BamFile({ bamPath: `test/data/${file}` })
    await bam.getHeader()
    const records = await bam.getRecordsForRange(refName, start, end)
    expect(records.length).toBe(expected)
  },
)
