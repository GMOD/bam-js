const BAI = require('../src/bai')
const BAM = require('../src/bamFile')
const LocalFile = require('../src/localFile')
const fs = require('fs')

const { JsonClone, REWRITE_EXPECTED_DATA } = require('./lib/util')

describe('index formats', () => {
  it('loads volvox-sorted.bam.bai', async () => {
    const ti = new BAI({
      filehandle: new LocalFile(
        require.resolve('./data/volvox-sorted.bam.bai'),
      ),
    })
    const indexData = await ti.parse()
    expect(indexData.bai).toEqual(true)
    expect(await ti.lineCount(0)).toEqual(9596)
    expect(await ti.hasDataForReferenceSequence(0)).toEqual(true)
  })
})
describe('bam header', () => {
  it('loads volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    await ti.getHeader()
    expect(ti.header).toEqual('@SQ	SN:ctgA	LN:50001\n')
    expect(ti.chrToIndex.ctgA).toEqual(0)
    expect(ti.indexToChr[0]).toEqual({ refName: 'ctgA', length: 50001 })
  })
  it('loads volvox-sorted.bam with csi index', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
      csiPath: require.resolve('./data/volvox-sorted.bam.csi'),
    })
    await ti.getHeader()
    expect(ti.header).toEqual('@SQ	SN:ctgA	LN:50001\n')
    expect(ti.chrToIndex.ctgA).toEqual(0)
    expect(ti.indexToChr[0]).toEqual({ refName: 'ctgA', length: 50001 })
  })
})

describe('bam records', () => {
  let ti
  beforeEach(() => {
    ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    return ti.getHeader()
  })
  it('gets features from volvox-sorted.bam', async () => {
    const records = await ti.getRecordsForRange('ctgA', 0, 1000)
    expect(records.length).toEqual(131)
    expect(records[0].get('start')).toEqual(2)
    expect(records[0].get('end')).toEqual(102)
    expect(records[0].get('cigar')).toEqual('100M')
    expect(records[0].get('name')).toEqual('ctgA_3_555_0:0:0_2:0:0_102d')
    expect(records[0].get('qual')).toEqual(
      '17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17',
    )
    expect(records[0].get('md')).toEqual('100')
    expect(records[0].getReadBases()).toEqual(
      'TTGTTGCGGAGTTGAACAACGGCATTAGGAACACTTCCGTCTCTCACTTTTATACGATTATGATTGGTTCTTTAGCCTTGGTTTAGATTGGTAGTAGTAG',
    )
  })
  it('gets out of bounds from volvox-sorted.bam', async () => {
    const records = await ti.getRecordsForRange('ctgA', 60000, 70000)
    expect(records.length).toEqual(0)
  })
  it('gets large chunk from volvox-sorted.bam', async () => {
    const promises = []
    const win = 1000
    for (let i = 0; i < 50000; i += win) {
      const records = ti.getRecordsForRange('ctgA', i, i + win)
      promises.push(records)
    }
    const recs = await Promise.all(promises)
    expect(recs.every(record => record.length > 0)).toBeTruthy()
  })

  it('gets specific weird chunk of volvox-sorted.bam', async () => {
    const records = await ti.getRecordsForRange('ctgA', 32749, 32799)
    expect(records.length).toEqual(14)
  })
  it('gets specific other weird chunk of volvox-sorted.bam', async () => {
    const records = await ti.getRecordsForRange('ctgA', 32799, 32849)
    expect(records.length).toEqual(12)
  })
})

describe('bam deep record check', () => {
  it('deep check volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('ctgA', 0, 10)

    if (REWRITE_EXPECTED_DATA) {
      fs.writeFileSync(
        'test/data/volvox-sorted.bam.expected.json',
        JSON.stringify(records, null, '  '),
      )
    }
    const ret = JSON.parse(
      fs.readFileSync('test/data/volvox-sorted.bam.expected.json'),
    )
    expect(JsonClone(records)).toEqual(ret)
  })
})

describe('1000 genomes bam check', () => {
  it('deep check 1000 genomes', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/1000genomes_hg00096_chr1.bam'),
      csiPath: require.resolve('./data/1000genomes_hg00096_chr1.bam.csi'),
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('1', 0, 1000)

    if (REWRITE_EXPECTED_DATA) {
      fs.writeFileSync(
        'test/data/1000genomes_hg00096_chr1.bam.expected.json',
        JSON.stringify(records, null, '  '),
      )
    }
    const ret = JSON.parse(
      fs.readFileSync('test/data/1000genomes_hg00096_chr1.bam.expected.json'),
    )
    expect(JsonClone(records)).toEqual(ret)
  })
  it('deep check 1000 genomes bai', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/1000genomes_hg00096_chr1.bam'),
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('1', 0, 1000)

    if (REWRITE_EXPECTED_DATA) {
      fs.writeFileSync(
        'test/data/1000genomes_hg00096_chr1.bam.bai.expected.json',
        JSON.stringify(records, null, '  '),
      )
    }
    const ret = JSON.parse(
      fs.readFileSync(
        'test/data/1000genomes_hg00096_chr1.bam.bai.expected.json',
      ),
    )
    expect(JsonClone(records)).toEqual(ret)
  })
})

describe('ecoli bam check', () => {
  it('check ecoli header and records', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/ecoli_nanopore.bam'),
    })
    const header = await ti.getHeader()
    const records = await ti.getRecordsForRange('ref000001|chr', 0, 100)

    if (REWRITE_EXPECTED_DATA) {
      fs.writeFileSync(
        'test/data/ecoli_nanopore.bam.expected.header.txt',
        header,
      )
      fs.writeFileSync(
        'test/data/ecoli_nanopore.bam.expected.records.json',
        JSON.stringify(records, null, '  '),
      )
    }
    const expectedHeader = JSON.parse(
      fs.readFileSync(
        'test/data/ecoli_nanopore.bam.expected.header.txt',
        'utf8',
      ),
    )
    const expectedRecords = JSON.parse(
      fs.readFileSync(
        'test/data/ecoli_nanopore.bam.expected.records.json',
        'utf8',
      ),
    )

    expect(header).toEqual(expectedHeader)
    expect(JsonClone(records)).toEqual(expectedRecords)
  })
})
describe('BAM with test_deletion_2_0.snps.bwa_align.sorted.grouped.bam', () => {
  let b
  beforeEach(async () => {
    b = new BAM({
      bamPath: 'test/data/test_deletion_2_0.snps.bwa_align.sorted.grouped.bam',
    })
    await b.getHeader()
  })

  it('constructs', () => {
    expect(b).toBeTruthy()
  })

  it('loads some data', async () => {
    const features = await b.getRecordsForRange('Chromosome', 17000, 18000)
    expect(features.length).toEqual(124)
    expect(
      features.every(
        feature => feature.get('seq_length') === feature.getReadBases().length,
      ),
    ).toBeTruthy()
  })
})

describe('BAM tiny', () => {
  it('loads some data', async () => {
    const b = new BAM({
      bamPath: 'test/data/tiny.bam',
    })
    await b.getHeader()
    const features = await b.getRecordsForRange('22', 30000000, 30010000)
    expect(features.length).toEqual(2)
  })
})

describe('BAM empty', () => {
  it('loads but does not crash', async () => {
    const b = new BAM({
      bamPath: 'test/data/empty.bam',
    })
    await b.getHeader()
    const features = await b.getRecordsForRange('22', 30000000, 30010000)
    expect(features.length).toEqual(0)
  })
})
