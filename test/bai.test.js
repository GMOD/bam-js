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
  })
  // it('loads volvox-sorted.bam.csi', async () => {
  //   const ti = new CSI({
  //     filehandle: new LocalFile(
  //       require.resolve('./data/volvox-sorted.bam.csi'),
  //     ),
  //   })
  //   const indexData = await ti.parse()
  //   expect(indexData.csi).toEqual(true)
  //   console.log(indexData)
  //   expect(await ti.lineCount('ctgA')).toEqual(9596)
  // })
})
describe('bam header', () => {
  it('loads volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    await ti.getHeader()
    expect(ti.header).toEqual('@SQ	SN:ctgA	LN:50001\n')
    expect(ti.chrToIndex.ctgA).toEqual(0)
    expect(ti.indexToChr[0]).toEqual({ name: 'ctgA', length: 50001 })
  })
  it('loads volvox-sorted.bam with csi index', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
      csiPath: require.resolve('./data/volvox-sorted.bam.csi'),
    })
    await ti.getHeader()
    expect(ti.header).toEqual('@SQ	SN:ctgA	LN:50001\n')
    expect(ti.chrToIndex.ctgA).toEqual(0)
    expect(ti.indexToChr[0]).toEqual({ name: 'ctgA', length: 50001 })
  })
})

describe('bam records', () => {
  it('gets features from volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('ctgA', 0, 1000)
    expect(records.length).toEqual(131)
    expect(records[0].get('start')).toEqual(2)
    expect(records[0].get('end')).toEqual(102)
    expect(records[0].get('cigar')).toEqual('100M')
    expect(records[0].getReadBases()).toEqual(
      'TTGTTGCGGAGTTGAACAACGGCATTAGGAACACTTCCGTCTCTCACTTTTATACGATTATGATTGGTTCTTTAGCCTTGGTTTAGATTGGTAGTAGTAG',
    )
  })
  it('gets out of bounds from volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('ctgA', 60000, 70000)
    expect(records.length).toEqual(0)
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
    console.log('wtf')
    const ti = new BAM({
      bamPath: require.resolve('./data/1000genomes_hg00096_chr1.bam'),
    })
    console.log('wtf2')
    const header = await ti.getHeader()
    console.log('wtf3',header)
    const records = await ti.getRecordsForRange('1', 0, 1000)
    console.log(records)

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
    const expectedHeader = fs.readFileSync(
      'test/data/ecoli_nanopore.bam.expected.header.txt',
      'utf8',
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
