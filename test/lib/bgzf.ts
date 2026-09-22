import { deflateRawSync } from 'node:zlib'

import crc32 from 'crc/calculators/crc32'

import { concatUint8Array } from '../../src/util.ts'

const EOF_BLOCK = Uint8Array.from([
  31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 27, 0, 3, 0, 0, 0, 0,
  0, 0, 0, 0, 0,
])

/** `data` as a BGZF stream, EOF marker included. */
export function bgzf(data: Uint8Array) {
  const blocks: Uint8Array[] = []
  for (let i = 0; i < data.length; i += 0xff00) {
    const raw = data.subarray(i, i + 0xff00)
    const deflated = deflateRawSync(raw)
    const block = new Uint8Array(18 + deflated.length + 8)
    const dv = new DataView(block.buffer)
    block.set([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0])
    dv.setUint16(16, block.length - 1, true)
    block.set(deflated, 18)
    dv.setUint32(18 + deflated.length, crc32(raw) >>> 0, true)
    dv.setUint32(22 + deflated.length, raw.length, true)
    blocks.push(block)
  }
  blocks.push(EOF_BLOCK)
  return concatUint8Array(blocks)
}
