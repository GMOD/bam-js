/* eslint-disable @typescript-eslint/ban-ts-ignore */
//@ts-ignore
import { Inflate, Z_SYNC_FLUSH } from 'pako'
import Chunk from './chunk'

export function unzip(inputData: Buffer) {
  let strm
  let pos = 0
  let i = 0
  const chunks = []
  do {
    const remainingInput = inputData.slice(pos)
    const inflator = new Inflate()
      //@ts-ignore
    ;({ strm } = inflator)
    //@ts-ignore
    inflator.push(remainingInput, Z_SYNC_FLUSH)
    if (inflator.err) throw new Error(inflator.msg)

    pos += strm.next_in
    //@ts-ignore
    chunks[i] = Buffer.from(inflator.result)
    i += 1
  } while (strm.avail_in)

  const result = Buffer.concat(chunks)

  return result
}

// similar to pakounzip, except it does extra counting and
// trimming to make sure to return only exactly the data
// range specified in the chunk
export function unzipChunk(inputData: Buffer, chunk: Chunk) {
  let strm
  let cpos = 0
  let dpos = 0
  const blocks = []
  const cpositions = []
  const dpositions = []
  let i = 0
  do {
    const remainingInput = inputData.slice(cpos)
    const inflator = new Inflate()
      //@ts-ignore
    ;({ strm } = inflator)
    //@ts-ignore
    inflator.push(remainingInput, Z_SYNC_FLUSH)
    if (inflator.err) throw new Error(inflator.msg)

    //@ts-ignore
    const buffer = Buffer.from(inflator.result)
    blocks.push(buffer)

    //     if (i == 0) {
    //       // this is the first chunk, trim it
    //       buffer = buffer.slice(chunk.minv.dataPosition)
    //       dpos += chunk.minv.dataPosition
    cpositions.push(cpos)
    dpositions.push(dpos)
    //       blocks.push(buffer)
    //     }
    //     if (chunk.minv.blockPosition + cpos >= chunk.maxv.blockPosition) {
    //       // this is the last chunk, trim it and stop decompressing
    //       // note if it is the same block is minv it subtracts that already
    //       // trimmed part of the slice length

    //       buffer = buffer.slice(
    //         0,
    //         chunk.maxv.blockPosition === chunk.minv.blockPosition
    //           ? chunk.maxv.dataPosition - chunk.minv.dataPosition + 1
    //           : chunk.maxv.dataPosition + 1,
    //       )
    //       cpositions.push(cpos)
    //       dpositions.push(dpos)
    //       blocks.push(buffer)
    //       break
    //     }
    cpos += strm.next_in
    dpos += buffer.length
    i++
  } while (strm.avail_in)

  const buffer = Buffer.concat(blocks)
  return { buffer, cpositions, dpositions }
}
