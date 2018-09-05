import { BaiIndex } from '../src/'

describe('BAI parser', () => {
  it('process bai index', async () => {
    const t = new BaiIndex({
      baiPath: require.resolve('./data/volvox-sorted.bam.bai'),
    })
    t.parseIndex()
  })
})
