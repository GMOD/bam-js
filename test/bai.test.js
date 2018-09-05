const VirtualOffset = require('../src/virtualOffset')
const BAI = require('../src/bai')
const LocalFile = require('../src/localFile')

describe('bai index', () => {
  it('loads volvox-sorted.bam.bai', async () => {
    const ti = new BAI({
      filehandle: new LocalFile(require.resolve('./data/volvox-sorted.bam.bai')),
    })
    const indexData = await ti.parse()
    console.log(indexData)
    // expect(metadata).toEqual({
    //   columnNumbers: { end: 5, ref: 1, start: 4 },
    //   coordinateType: '1-based-closed',
    //   format: 'generic',
    //   firstDataLine: new VirtualOffset(0, 0),
    //   metaChar: '#',
    //   refIdToName: ['1', 'ctgB'],
    //   refNameToId: { 1: 0, ctgB: 1 },
    //   skipLines: 0,
    //   maxBlockSize: 1 << 16,
    // })
  })
})
