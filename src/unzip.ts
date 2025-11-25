import { Inflate, Z_SYNC_FLUSH } from 'pako-esm2'

export interface BlockCache {
  get(key: string): { buffer: Uint8Array; nextIn: number } | undefined
  set(key: string, value: { buffer: Uint8Array; nextIn: number }): void
}

interface VirtualOffset {
  blockPosition: number
  dataPosition: number
}

interface Chunk {
  minv: VirtualOffset
  maxv: VirtualOffset
}

function concatUint8Array(args: Uint8Array[], totalLength: number) {
  const mergedArray = new Uint8Array(totalLength)
  let offset = 0
  for (const entry of args) {
    mergedArray.set(entry, offset)
    offset += entry.length
  }
  return mergedArray
}

export async function unzip(inputData: Uint8Array) {
  try {
    let strm
    let pos = 0
    let inflator
    const blocks = [] as Uint8Array[]
    let totalLength = 0
    do {
      const remainingInput = inputData.subarray(pos)
      inflator = new Inflate(undefined)
      ;({ strm } = inflator)
      inflator.push(remainingInput, Z_SYNC_FLUSH)
      if (inflator.err) {
        throw new Error(inflator.msg)
      }

      pos += strm!.next_in
      const result = inflator.result as Uint8Array
      blocks.push(result)
      totalLength += result.length
    } while (strm!.avail_in)

    return concatUint8Array(blocks, totalLength)
  } catch (e) {
    if (/incorrect header check/.exec(`${e}`)) {
      throw new Error(
        'problem decompressing block: incorrect gzip header check',
      )
    }
    throw e
  }
}

export async function unzipChunkSlice(
  inputData: Uint8Array,
  chunk: Chunk,
  blockCache?: BlockCache,
) {
  try {
    let strm
    const { minv, maxv } = chunk
    let cpos = minv.blockPosition
    let dpos = minv.dataPosition
    const chunks = [] as Uint8Array[]
    const cpositions = [] as number[]
    const dpositions = [] as number[]

    let i = 0
    let wasFromCache = false
    let totalLength = 0
    do {
      const remainingInput = inputData.subarray(cpos - minv.blockPosition)
      const cacheKey = cpos.toString()

      let buffer: Uint8Array
      let nextIn: number

      const cached = blockCache?.get(cacheKey)
      if (cached) {
        buffer = cached.buffer
        nextIn = cached.nextIn
        wasFromCache = true
      } else {
        const inflator = new Inflate(undefined)
        ;({ strm } = inflator)
        inflator.push(remainingInput, Z_SYNC_FLUSH)
        if (inflator.err) {
          throw new Error(inflator.msg)
        }

        buffer = inflator.result as Uint8Array
        nextIn = strm!.next_in
        wasFromCache = false

        blockCache?.set(cacheKey, { buffer, nextIn })
      }

      chunks.push(buffer)
      let len = buffer.length

      cpositions.push(cpos)
      dpositions.push(dpos)
      if (chunks.length === 1 && minv.dataPosition) {
        chunks[0] = chunks[0]!.subarray(minv.dataPosition)
        len = chunks[0].length
      }
      const origCpos = cpos
      cpos += nextIn
      dpos += len

      if (origCpos >= maxv.blockPosition) {
        chunks[i] = chunks[i]!.subarray(
          0,
          maxv.blockPosition === minv.blockPosition
            ? maxv.dataPosition - minv.dataPosition + 1
            : maxv.dataPosition + 1,
        )
        totalLength += chunks[i]!.length

        cpositions.push(cpos)
        dpositions.push(dpos)
        break
      }
      totalLength += len
      i++
    } while (
      wasFromCache
        ? cpos < inputData.length + minv.blockPosition
        : strm!.avail_in
    )

    return {
      buffer: concatUint8Array(chunks, totalLength),
      cpositions,
      dpositions,
    }
  } catch (e) {
    if (/incorrect header check/.exec(`${e}`)) {
      throw new Error(
        'problem decompressing block: incorrect gzip header check',
      )
    }
    throw e
  }
}
