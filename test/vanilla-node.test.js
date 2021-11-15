import fs from 'fs'
import { BAI, BamFile } from '../src'

describe('using vanilla node filehandles', () => {
  it('loads volvox-sorted.bam.bai', async () => {
    const filehandle = await fs.promises.open(
      require.resolve('./data/volvox-sorted.bam.bai'),
    )

    const ti = new BAI({
      filehandle,
    })
    const indexData = await ti.parse()
    expect(indexData.bai).toEqual(true)
    expect(await ti.lineCount(0)).toEqual(9596)
    expect(await ti.hasRefSeq(0)).toEqual(true)
    filehandle.close()
  })

  it('gets features from volvox-sorted.bam', async () => {
    const bam = await fs.promises.open(
      require.resolve('./data/volvox-sorted.bam'),
    )
    const bai = await fs.promises.open(
      require.resolve('./data/volvox-sorted.bam.bai'),
    )
    const ti = new BamFile({
      bamFilehandle: bam,
      baiFilehandle: bai,
    })
    await ti.getHeader()
    const records = await ti.getRecordsForRange('ctgA', 0, 1000)
    expect(records.length).toEqual(131)
    expect(records[0].get('start')).toEqual(2)
    expect(records[0].get('end')).toEqual(102)
    expect(records[0].get('cigar')).toEqual('100M')
    expect(records[0].get('name')).toEqual('ctgA_3_555_0:0:0_2:0:0_102d')
    expect(records[0].get('qual')).toEqual(
      '17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17',
    )
    expect(records[0].get('md')).toEqual('100')
    expect(records[0].getReadBases()).toEqual(
      'TTGTTGCGGAGTTGAACAACGGCATTAGGAACACTTCCGTCTCTCACTTTTATACGATTATGATTGGTTCTTTAGCCTTGGTTTAGATTGGTAGTAGTAG',
    )
    bam.close()
    bai.close()
  })
})
