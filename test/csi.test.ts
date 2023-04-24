import { BamFile } from '../src'

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
  expect(features[2].get('sa')).toEqual('ref,29,-,6H5M,17,0;')
  expect(features[4].get('sa')).toEqual('ref,9,+,5S6M,30,1;')
})
