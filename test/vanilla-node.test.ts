import { expect, test } from 'vitest'
import fs from 'fs'
import { BAI, BamFile } from '../src'

test('loads volvox-sorted.bam.bai', async () => {
  const filehandle = await fs.promises.open('test/data/volvox-sorted.bam.bai')

  const ti = new BAI({
    // @ts-expect-error
    filehandle,
  })
  const indexData = await ti.parse()
  expect(indexData.bai).toEqual(true)
  expect(await ti.lineCount(0)).toEqual(9596)
  expect(await ti.hasRefSeq(0)).toEqual(true)
  await filehandle.close()
})

test('gets features from volvox-sorted.bam', async () => {
  const bam = await fs.promises.open('test/data/volvox-sorted.bam')
  const bai = await fs.promises.open('test/data/volvox-sorted.bam.bai')
  const ti = new BamFile({
    // @ts-expect-error
    bamFilehandle: bam,
    // @ts-expect-error
    baiFilehandle: bai,
  })
  await ti.getHeader()
  const records = await ti.getRecordsForRange('ctgA', 0, 1000)
  expect(records.length).toEqual(131)
  expect(records[0].start).toEqual(2)
  expect(records[0].end).toEqual(102)
  expect(records[0].CIGAR).toEqual('100M')
  expect(records[0].name).toEqual('ctgA_3_555_0:0:0_2:0:0_102d')
  expect(records[0].qual).toEqual(
    '17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17 17',
  )
  expect(records[0].tags.MD).toEqual('100')
  expect(records[0].seq).toEqual(
    'TTGTTGCGGAGTTGAACAACGGCATTAGGAACACTTCCGTCTCTCACTTTTATACGATTATGATTGGTTCTTTAGCCTTGGTTTAGATTGGTAGTAGTAG',
  )
  await bam.close()
  await bai.close()
})
