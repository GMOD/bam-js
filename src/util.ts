import Chunk from './chunk.ts'
import { longFromBytesToUnsigned } from './long.ts'
import { Offset, VirtualOffset } from './virtualOffset.ts'

export function canMergeBlocks(chunk1: Chunk, chunk2: Chunk) {
  return chunk2.minv.blockPosition - chunk1.maxv.blockPosition < 65000
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
  const mergedChunks: Chunk[] = []
  let lastChunk: Chunk | undefined

  if (chunks.length === 0) {
    return chunks
  }

  chunks.sort((c0, c1) => {
    const dif = c0.minv.blockPosition - c1.minv.blockPosition
    return dif === 0 ? c0.minv.dataPosition - c1.minv.dataPosition : dif
  })

  for (const chunk of chunks) {
    if (!lowest || chunk.maxv.compareTo(lowest) > 0) {
      if (lastChunk === undefined) {
        mergedChunks.push(chunk)
        lastChunk = chunk
      } else {
        if (canMergeBlocks(lastChunk, chunk)) {
          if (chunk.maxv.compareTo(lastChunk.maxv) > 0) {
            lastChunk.maxv = chunk.maxv
          }
        } else {
          mergedChunks.push(chunk)
          lastChunk = chunk
        }
      }
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
