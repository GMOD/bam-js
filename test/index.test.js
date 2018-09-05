import {BaiIndex} from "../src/";
describe('FASTA parser', () => {
  it('process unindexed fasta', async () => {
    const t = new BaiIndex({ bai: testDataFile('volvox-sorted.bam.bai') })
  })
})
