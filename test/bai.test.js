const BAI = require('../src/bai')
const BAM = require('../src/bamFile')
const LocalFile = require('../src/localFile')

const {
  loadTestJSON,
  JsonClone,
  REWRITE_EXPECTED_DATA,
  fs,
} = require('./lib/util')

describe('bai index', () => {
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
    expect(records[0].get('_flags')).toEqual(0)
    expect(records[0].get('cigar')).toEqual('100M')
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
    const ret = await loadTestJSON('volvox-sorted.bam.expected.json')
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
        header
      )
      fs.writeFileSync(
        'test/data/ecoli_nanopore.bam.expected.records.json',
        JSON.stringify(records, null, '  '),
      )
    }
    const expectedHeader = fs.readFileSync('test/data/ecoli_nanopore.bam.expected.header.txt', 'utf8')
    const expectedRecords = await loadTestJSON('ecoli_nanopore.bam.expected.records.json')
    console.log(expectedRecords)


    expect(header).toEqual(expectedHeader)
    expect(records).toEqual(expectedRecords)
  })
})
