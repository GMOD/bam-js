const BAM = require('../src/bamFile')

describe('bam header', () => {
  it('loads volvox-sorted.bam', async () => {
    const ti = new BAM({
      bamPath: require.resolve('./data/volvox-sorted.bam'),
    })
    const indexData = await ti.getHeader()
    console.log(indexData)
    // expect(indexData.bai).toEqual(true)
  })
})
