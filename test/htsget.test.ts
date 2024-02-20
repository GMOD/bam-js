import { HtsgetFile } from '../src'
import fetchMock from 'jest-fetch-mock'
import fs from 'fs'

beforeEach(() => {
  jest.restoreAllMocks()
})

xdescribe('htsspec htsget wtsi', () => {
  it('wtsi', async () => {
    const ti = new HtsgetFile({
      baseUrl: 'https://htsget.wtsi-npg-test.co.uk:9090/npg_ranger',
      trackId: 'ga4gh/sample/NA12878',
    })
    await ti.getHeader()
    console.log(ti)
  })
})

const result = fs.readFileSync('test/htsget/result.json', 'utf8')

xtest('dnanexus with mock', async () => {
  fetchMock.mockIf(
    'http://htsnexus.rnd.dnanex.us/v1/reads/BroadHiSeqX_b37/NA12878?referenceName=na&class=header',
    result,
  )
  fetchMock.mockIf(
    'https://dl.dnanex.us/F/D/Pb1QjgQx9j2bZ8Q44x50xf4fQV3YZBgkvkz23FFB/NA12878_recompressed.bam',

    // @ts-expect-error
    () => {
      const result = fs.readFileSync('test/htsget/data.bam')
      return {
        status: 206,
        body: result,
      }
    },
  )
  const ti = new HtsgetFile({
    baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
    trackId: 'BroadHiSeqX_b37/NA12878',
  })
  const header = await ti.getHeader()
  expect(header).toBeTruthy()
  const records = await ti.getRecordsForRange('1', 2000000, 2000001)
  expect(records.length).toBe(39)
})

xtest('dnanexus without mock', async () => {
  const ti = new HtsgetFile({
    baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
    trackId: 'BroadHiSeqX_b37/NA12878',
  })
  const header = await ti.getHeader()
  expect(header).toBeTruthy()
  const records = await ti.getRecordsForRange('1', 2000000, 2000001)
  expect(records.length).toBe(39)
})
