import { readFileSync } from 'node:fs'

import { unzip } from '@gmod/bgzf-filehandle'
import { expect, test } from 'vitest'

import Chunk from '../src/chunk.ts'
import { BamFile, streamBamRecords } from '../src/index.ts'
import { parseRefSeqs } from '../src/util.ts'
import { VirtualOffset } from '../src/virtualOffset.ts'
import { bgzf } from './lib/bgzf.ts'

// tiny.bam decompressed, with its first record's block_size overwritten. -4
// leaves a loop advancing by block_size where it started; 8 is positive but
// too short for the fixed fields every record has.
async function withFirstBlockSize(blockSize: number) {
  const bytes = await unzip(readFileSync('test/data/tiny.bam'))
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = parseRefSeqs(bytes, 8 + dv.getInt32(4, true), s => s)!.end
  dv.setInt32(first, blockSize, true)
  return { bytes, first }
}

test.for([-4, 8])(
  'a block_size of %i fails an indexed read instead of hanging it',
  async blockSize => {
    const { bytes, first } = await withFirstBlockSize(blockSize)
    const bam = new BamFile({ bamPath: 'test/data/tiny.bam' })
    const chunk = new Chunk(new VirtualOffset(0, 0), new VirtualOffset(0, 0), 0)
    expect(() =>
      bam.readBamFeatures(bytes.subarray(first), [], [], chunk),
    ).toThrow(`block_size ${blockSize}`)
  },
)

test.for([-4, 8])(
  'a block_size of %i fails a stream instead of hanging it',
  async blockSize => {
    const { bytes } = await withFirstBlockSize(blockSize)
    const compressed = bgzf(bytes)
    const bamFilehandle = {
      read: async (length: number, position: number) =>
        compressed.subarray(position, position + length),
    } as unknown as NonNullable<
      Parameters<typeof streamBamRecords>[0]['bamFilehandle']
    >
    await expect(
      Array.fromAsync(streamBamRecords({ bamFilehandle })),
    ).rejects.toThrow(`block_size ${blockSize}`)
  },
)

test('the BGZF writer round-trips an unmodified file', async () => {
  const bytes = await unzip(readFileSync('test/data/tiny.bam'))
  expect(await unzip(bgzf(bytes))).toEqual(bytes)
})
