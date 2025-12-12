import Chunk from './chunk.ts'
import { longFromBytesToUnsigned } from './long.ts'
import { Offset, VirtualOffset } from './virtualOffset.ts'

export function canMergeBlocks(chunk1: Chunk, chunk2: Chunk) {
  return (
    chunk2.minv.blockPosition - chunk1.maxv.blockPosition < 65000 &&
    chunk2.maxv.blockPosition - chunk1.minv.blockPosition < 5000000
  )
}

export interface BamOpts {
  viewAsPairs?: boolean
  pairAcrossChr?: boolean
  maxInsertSize?: number
  signal?: AbortSignal
}

export interface BaseOpts {
  signal?: AbortSignal
}

export function makeOpts(obj: AbortSignal | BaseOpts = {}): BaseOpts {
  return 'aborted' in obj ? ({ signal: obj } as BaseOpts) : obj
}

export function optimizeChunks(chunks: Chunk[], lowest?: Offset) {
  const n = chunks.length
  if (n === 0) {
    return chunks
  }

  // Pre-filter chunks below lowest threshold before sorting
  let filtered: Chunk[]
  if (lowest) {
    const lowestBlock = lowest.blockPosition
    const lowestData = lowest.dataPosition
    filtered = []
    for (let i = 0; i < n; i++) {
      const chunk = chunks[i]!
      const maxv = chunk.maxv
      const cmp =
        maxv.blockPosition - lowestBlock || maxv.dataPosition - lowestData
      if (cmp > 0) {
        filtered.push(chunk)
      }
    }
    if (filtered.length === 0) {
      return filtered
    }
  } else {
    filtered = chunks
  }

  filtered.sort((c0, c1) => {
    const dif = c0.minv.blockPosition - c1.minv.blockPosition
    return dif !== 0 ? dif : c0.minv.dataPosition - c1.minv.dataPosition
  })

  const mergedChunks: Chunk[] = []
  let lastChunk = filtered[0]!
  mergedChunks.push(lastChunk)

  for (let i = 1; i < filtered.length; i++) {
    const chunk = filtered[i]!
    if (canMergeBlocks(lastChunk, chunk)) {
      const chunkMaxv = chunk.maxv
      const lastMaxv = lastChunk.maxv
      const cmp =
        chunkMaxv.blockPosition - lastMaxv.blockPosition ||
        chunkMaxv.dataPosition - lastMaxv.dataPosition
      if (cmp > 0) {
        lastChunk.maxv = chunkMaxv
      }
    } else {
      mergedChunks.push(chunk)
      lastChunk = chunk
    }
  }

  return mergedChunks
}

export function parsePseudoBin(bytes: Uint8Array, offset: number) {
  return {
    lineCount: longFromBytesToUnsigned(bytes, offset),
  }
}

export function findFirstData(
  firstDataLine: VirtualOffset | undefined,
  virtualOffset: VirtualOffset,
) {
  return firstDataLine
    ? firstDataLine.compareTo(virtualOffset) > 0
      ? virtualOffset
      : firstDataLine
    : virtualOffset
}

export function parseNameBytes(
  namesBytes: Uint8Array,
  renameRefSeq: (arg: string) => string = s => s,
) {
  let currRefId = 0
  let currNameStart = 0
  const refIdToName = []
  const refNameToId: Record<string, number> = {}
  for (let i = 0; i < namesBytes.length; i += 1) {
    if (!namesBytes[i]) {
      if (currNameStart < i) {
        let refName = ''
        for (let j = currNameStart; j < i; j++) {
          refName += String.fromCharCode(namesBytes[j]!)
        }
        refName = renameRefSeq(refName)
        refIdToName[currRefId] = refName
        refNameToId[refName] = currRefId
      }
      currNameStart = i + 1
      currRefId += 1
    }
  }
  return { refNameToId, refIdToName }
}

export function concatUint8Array(args: Uint8Array[]) {
  let totalLength = 0
  for (const entry of args) {
    totalLength += entry.length
  }
  const mergedArray = new Uint8Array(totalLength)
  let offset = 0
  for (const entry of args) {
    mergedArray.set(entry, offset)
    offset += entry.length
  }
  return mergedArray
}

export async function gen2array<T>(gen: AsyncIterable<T[]>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) {
    for (const item of x) {
      out.push(item)
    }
  }
  return out
}
