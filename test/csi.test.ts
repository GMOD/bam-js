import { expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'

class HalfAbortController {
  signal: { aborted: boolean }
  constructor() {
    this.signal = { aborted: false }
  }

  abort() {
    this.signal.aborted = true
  }
}

test('loads volvox-sorted.bam with csi index', async () => {
  const ti = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    csiPath: 'test/data/volvox-sorted.bam.csi',
  })
  await ti.getHeader()
  expect(ti.header).toEqual('@SQ	SN:ctgA	LN:50001\n')
  expect(ti.chrToIndex?.ctgA).toEqual(0)
  expect(ti.indexToChr?.[0]).toEqual({ refName: 'ctgA', length: 50001 })
})

test('deep check 1000 genomes', async () => {
  const ti = new BamFile({
    bamPath: 'test/data/1000genomes_hg00096_chr1.bam',
    csiPath: 'test/data/1000genomes_hg00096_chr1.bam.csi',
  })
  await ti.getHeader()
  const records = await ti.getRecordsForRange('1', 0, 1000)
  expect(records).toMatchSnapshot()
})
test('deep check 1000 genomes csi', async () => {
  const ti = new BamFile({
    bamPath: 'test/data/1000genomes_hg00096_chr1.bam',
    csiPath: 'test/data/1000genomes_hg00096_chr1.bam.csi',
  })
  await ti.getHeader()
  const records = await ti.getRecordsForRange('1', 0, 1000)
  expect(records).toMatchSnapshot()
})
test('start to deep check 1000 genomes but abort instead', async () => {
  const aborter = new HalfAbortController()
  const ti = new BamFile({
    bamPath: 'test/data/1000genomes_hg00096_chr1.bam',
    csiPath: 'test/data/1000genomes_hg00096_chr1.bam.csi',
  })
  const recordsP = ti
    .getHeader({ signal: aborter.signal as AbortSignal })
    .then(() =>
      ti.getRecordsForRange('1', 0, 1000, {
        signal: aborter.signal as AbortSignal,
      }),
    )
  aborter.abort()
  await expect(recordsP).rejects.toThrow(/aborted/)
})

test('BamFile+CSI with large coordinates', async () => {
  const b = new BamFile({
    bamPath: 'test/data/large_coords.bam',
    csiPath: 'test/data/large_coords.bam.csi',
  })
  await b.getHeader()

  const features = await b.getRecordsForRange(
    'ctgA',
    1073741824,
    1073741824 + 50000,
  )
  expect(features.length).toEqual(9596)
})

test('SAM spec pdf', async () => {
  const b = new BamFile({
    bamPath: 'test/data/samspec.bam',
    csiPath: 'test/data/samspec.bam.csi',
  })
  await b.getHeader()

  const features = await b.getRecordsForRange('ref', 1, 100)
  expect(features.length).toEqual(6)
  expect(features[2]!.tags.SA).toEqual('ref,29,-,6H5M,17,0;')
  expect(features[4]!.tags.SA).toEqual('ref,9,+,5S6M,30,1;')
})

// CSI has no linear index (CSIv1.tex §3), so getLowestChunk returns 0:0 and
// optimizeChunks never narrows a query by it — every chunk of every overlapping
// bin survives. The batch-and-stop in _fetchChunkFeatures (ADR 0010) is
// therefore at least as load-bearing here as it is for BAI, but every other
// .csi fixture in this repo resolves to a single chunk, so nothing exercised it.
//
// This file's index hands a narrow window 22 chunks. Pinning CSI against BAI
// keeps both the record set and the number of chunks actually read in step.
test.each([
  ['22', 16_000_000, 10_000],
  ['22', 16_000_000, 100_000],
  ['22', 16_450_000, 40_000],
  ['22', 16_000_000, 800_000],
])('csi matches bai on %s:%i+%i, reads included', async (ref, start, w) => {
  const open = (idx: 'bai' | 'csi') => {
    const bam = new BamFile(
      idx === 'bai'
        ? {
            bamPath: 'test/data/chr22_nanopore_subset.bam',
            baiPath: 'test/data/chr22_nanopore_subset.bam.bai',
          }
        : {
            bamPath: 'test/data/chr22_nanopore_subset.bam',
            csiPath: 'test/data/chr22_nanopore_subset.bam.csi',
          },
    )
    const stats = { reads: 0 }
    const inner = bam._readChunkFeatures.bind(bam)
    bam._readChunkFeatures = async (chunk, opts) => {
      stats.reads++
      return inner(chunk, opts)
    }
    return { bam, stats }
  }

  const bai = open('bai')
  const csi = open('csi')
  await bai.bam.getHeader()
  await csi.bam.getHeader()

  const baiChunks = await bai.bam.blocksForRange(ref, start, start + w)
  const csiChunks = await csi.bam.blocksForRange(ref, start, start + w)
  const baiRecs = await bai.bam.getRecordsForRange(ref, start, start + w)
  const csiRecs = await csi.bam.getRecordsForRange(ref, start, start + w)

  expect(csiChunks.length).toBe(baiChunks.length)
  expect(csiRecs.map(r => r.fileOffset)).toEqual(baiRecs.map(r => r.fileOffset))
  // the early stop fires the same way on both
  expect(csi.stats.reads).toBe(bai.stats.reads)
  expect(csi.stats.reads).toBeLessThanOrEqual(csiChunks.length)
})
