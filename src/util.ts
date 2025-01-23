import Chunk from './chunk'
import { longFromBytesToUnsigned } from './long'
import VirtualOffset from './virtualOffset'

export function timeout(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Properly check if the given AbortSignal is aborted.
 *
 * Per the standard, if the signal reads as aborted, this function throws
 * either a DOMException AbortError, or a regular error with a `code` attribute
 * set to `ERR_ABORTED`.
 *
 * For convenience, passing `undefined` is a no-op
 *
 * @param {AbortSignal} [signal] an AbortSignal, or anything with an `aborted` attribute
 * @returns nothing
 */
export function checkAbortSignal(signal?: AbortSignal) {
  if (!signal) {
    return
  }

  if (signal.aborted) {
    // console.log('bam aborted!')
    if (typeof DOMException === 'undefined') {
      const e = new Error('aborted')
      //@ts-ignore
      e.code = 'ERR_ABORTED'
      throw e
    } else {
      throw new DOMException('aborted', 'AbortError')
    }
  }
}

/**
 * Skips to the next tick, then runs `checkAbortSignal`.
 * Await this to inside an otherwise synchronous loop to
 * provide a place to break when an abort signal is received.
 * @param {AbortSignal} signal
 */
export async function abortBreakPoint(signal?: AbortSignal) {
  await Promise.resolve()
  checkAbortSignal(signal)
}

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

export function optimizeChunks(chunks: Chunk[], lowest?: VirtualOffset) {
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

export function sum(array: Uint8Array[]) {
  let sum = 0
  for (const entry of array) {
    sum += entry.length
  }
  return sum
}
export function concatUint8Array(args: Uint8Array[]) {
  const mergedArray = new Uint8Array(sum(args))
  let offset = 0
  for (const entry of args) {
    mergedArray.set(entry, offset)
    offset += entry.length
  }
  return mergedArray
}


export async function gen2array<T>(gen: AsyncIterable<T[]>): Promise<T[]> {
  let out: T[] = []
  for await (const x of gen) {
    out = out.concat(x)
  }
  return out
}


