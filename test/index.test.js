import {BaiIndex} from "../src/";
describe('FASTA parser', () => {
  it('process unindexed fasta', async () => {
    const t = new BaiIndex({ baiPath: require.resolve('./data/volvox-sorted.bam.bai') })
  })
})
