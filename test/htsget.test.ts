// @ts-nocheck
import { HtsgetFile } from '../src'
import * as fs from 'fs'

// const fetch = req => {
//   const result = fs.readFileSync(
//     require.resolve('./htsget/result.json'),
//     'utf8',
//   )
//   if (
//     req ===
//     'http://htsnexus.rnd.dnanex.us/v1/reads/BroadHiSeqX_b37/NA12878?referenceName=na&class=header'
//   ) {
//     return new Response(result, { status: 200 })
//   } else if (
//     req ===
//     'https://dl.dnanex.us/F/D/Pb1QjgQx9j2bZ8Q44x50xf4fQV3YZBgkvkz23FFB/NA12878_recompressed.bam'
//   ) {
//     const result = fs.readFileSync(require.resolve('./htsget/data.bam'))
//     return new Response(result, { status: 206 })
//   } else {
//     return new Response(result, { status: 200 })
//   }
// }

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

test('dnanexus with mock', async () => {
  // global.fetch = jest.fn().mockImplementation(fetch)
  const ti = new HtsgetFile({
    baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
    trackId: 'BroadHiSeqX_b37/NA12878',
  })
  const header = await ti.getHeader()
  expect(header).toBeTruthy()
  const records = await ti.getRecordsForRange(1, 2000000, 2000001)
  expect(records.length).toBe(39)
})

test('dnanexus without mock', async () => {
  const ti = new HtsgetFile({
    baseUrl: 'http://htsnexus.rnd.dnanex.us/v1/reads',
    trackId: 'BroadHiSeqX_b37/NA12878',
  })
  const header = await ti.getHeader()
  expect(header).toBeTruthy()
  const records = await ti.getRecordsForRange(1, 2000000, 2000001)
  expect(records.length).toBe(39)
})
