import { HtsgetFile } from '../src'

xdescribe('htsspec htsget wtsi', () => {
  it('loads volvox-sorted.bam', async () => {
    const ti = new HtsgetFile({
      baseUrl: 'https://htsget.wtsi-npg-test.co.uk:9090/npg_ranger',
      baseUrl: 'ga4gh/sample/NA12878',
    })
    await ti.getHeader()
    console.log(ti)
  })
})

describe('htsspec dnanexus', () => {
  it('loads volvox-sorted.bam', async () => {
    const ti = new HtsgetFile({
      baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
      trackId: 'BroadHiSeqX_b37/NA12878',
    })
    const header = await ti.getHeader()
    expect(header).toBeTruthy()
  })
})
