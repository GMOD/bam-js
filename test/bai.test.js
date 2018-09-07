const BAI = require('../src/bai')
const BAM = require('../src/bamFile')
const LocalFile = require('../src/localFile')

describe('bai index', () => {
  it('loads volvox-sorted.bam.bai', async () => {
    const ti = new BAI({
      filehandle: new LocalFile(
        require.resolve('./data/volvox-sorted.bam.bai'),
      ),
    })
    const indexData = await ti.parse()
    expect(indexData.bai).toEqual(true)
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
