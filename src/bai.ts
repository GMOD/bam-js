import QuickLRU from 'quick-lru'

import Chunk from './chunk.ts'
import IndexFile from './indexFile.ts'
import {
  BaseOpts,
  findFirstData,
  optimizeChunks,
  parsePseudoBin,
} from './util.ts'
import { VirtualOffset, fromBytes } from './virtualOffset.ts'

const BAI_MAGIC = 21578050 // BAI\1

function roundDown(n: number, multiple: number) {
  return n - (n % multiple)
}
function roundUp(n: number, multiple: number) {
  return n - (n % multiple) + multiple
}

export interface IndexCovEntry {
  start: number
  end: number
  score: number
}

function reg2bins(beg: number, end: number) {
  end -= 1
  return [
    [0, 0],
    [1 + (beg >> 26), 1 + (end >> 26)],
    [9 + (beg >> 23), 9 + (end >> 23)],
    [73 + (beg >> 20), 73 + (end >> 20)],
    [585 + (beg >> 17), 585 + (end >> 17)],
    [4681 + (beg >> 14), 4681 + (end >> 14)],
  ] as const
}

export default class BAI extends IndexFile {
  public setupP?: ReturnType<BAI['_parse']>

  async lineCount(refId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return indexData.indices(refId)?.stats?.lineCount || 0
  }

  async _parse(_opts?: BaseOpts) {
    const bytes = await this.filehandle.readFile()
    const dataView = new DataView(bytes.buffer)

    // check BAI magic numbers
    if (dataView.getUint32(0, true) !== BAI_MAGIC) {
      throw new Error('Not a BAI file')
    }

    const refCount = dataView.getInt32(4, true)
    const depth = 5
    const binLimit = ((1 << ((depth + 1) * 3)) - 1) / 7

    // read the indexes for each reference sequence
    let curr = 8
    let firstDataLine: VirtualOffset | undefined

    const offsets = [] as number[]
    for (let i = 0; i < refCount; i++) {
      offsets.push(curr)
      const binCount = dataView.getInt32(curr, true)

      curr += 4

      for (let j = 0; j < binCount; j += 1) {
        const bin = dataView.getUint32(curr, true)
        curr += 4
        if (bin === binLimit + 1) {
          curr += 4
          curr += 32
        } else if (bin > binLimit + 1) {
          throw new Error('bai index contains too many bins, please use CSI')
        } else {
          const chunkCount = dataView.getInt32(curr, true)
          curr += 4
          for (let k = 0; k < chunkCount; k++) {
            curr += 8
            curr += 8
          }
        }
      }

      const linearCount = dataView.getInt32(curr, true)
      curr += 4
      // as we're going through the linear index, figure out the smallest
      // virtual offset in the indexes, which tells us where the BAM header
      // ends
      const linearIndex = new Array<VirtualOffset>(linearCount)
      for (let j = 0; j < linearCount; j++) {
        const offset = fromBytes(bytes, curr)
        curr += 8
        firstDataLine = findFirstData(firstDataLine, offset)
        linearIndex[j] = offset
      }
    }
    const indicesCache = new QuickLRU<number, ReturnType<typeof getIndices>>({
      maxSize: 5,
    })

    function getIndices(refId: number) {
      let curr = offsets[refId]
      if (curr === undefined) {
        return undefined
      }
      const binCount = dataView.getInt32(curr, true)
      let stats

      curr += 4
      const binIndex: Record<number, Chunk[]> = {}

      for (let j = 0; j < binCount; j += 1) {
        const bin = dataView.getUint32(curr, true)
        curr += 4
        if (bin === binLimit + 1) {
          curr += 4
          stats = parsePseudoBin(bytes, curr + 16)
          curr += 32
        } else if (bin > binLimit + 1) {
          throw new Error('bai index contains too many bins, please use CSI')
        } else {
          const chunkCount = dataView.getInt32(curr, true)
          curr += 4
          const chunks = new Array<Chunk>(chunkCount)
          for (let k = 0; k < chunkCount; k++) {
            const u = fromBytes(bytes, curr)
            curr += 8
            const v = fromBytes(bytes, curr)
            curr += 8
            firstDataLine = findFirstData(firstDataLine, u)
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      const linearCount = dataView.getInt32(curr, true)
      curr += 4
      // as we're going through the linear index, figure out the smallest
      // virtual offset in the indexes, which tells us where the BAM header
      // ends
      const linearIndex = new Array<VirtualOffset>(linearCount)
      for (let j = 0; j < linearCount; j++) {
        const offset = fromBytes(bytes, curr)
        curr += 8
        firstDataLine = findFirstData(firstDataLine, offset)
        linearIndex[j] = offset
      }

      return {
        binIndex,
        linearIndex,
        stats,
      }
    }

    return {
      bai: true,
      firstDataLine,
      maxBlockSize: 1 << 16,
      indices: (refId: number) => {
        if (!indicesCache.has(refId)) {
          const result = getIndices(refId)
          if (result) {
            indicesCache.set(refId, result)
          }
          return result
        }
        return indicesCache.get(refId)
      },
      refCount,
    }
  }

  async indexCov(
    seqId: number,
    start?: number,
    end?: number,
    opts?: BaseOpts,
  ): Promise<IndexCovEntry[]> {
    const v = 16384
    const range = start !== undefined
    const indexData = await this.parse(opts)
    const seqIdx = indexData.indices(seqId)

    if (!seqIdx) {
      return []
    }
    const { linearIndex = [], stats } = seqIdx
    if (linearIndex.length === 0) {
      return []
    }
    const e = end === undefined ? (linearIndex.length - 1) * v : roundUp(end, v)
    const s = start === undefined ? 0 : roundDown(start, v)
    const depths = range
      ? new Array((e - s) / v)
      : new Array(linearIndex.length - 1)
    const totalSize = linearIndex[linearIndex.length - 1]!.blockPosition
    if (e > (linearIndex.length - 1) * v) {
      throw new Error('query outside of range of linear index')
    }
    let currentPos = linearIndex[s / v]!.blockPosition
    for (let i = s / v, j = 0; i < e / v; i++, j++) {
      depths[j] = {
        score: linearIndex[i + 1]!.blockPosition - currentPos,
        start: i * v,
        end: i * v + v,
      }
      currentPos = linearIndex[i + 1]!.blockPosition
    }
    return depths.map(d => ({
      ...d,
      score: (d.score * (stats?.lineCount || 0)) / totalSize,
    }))
  }

  async blocksForRange(
    refId: number,
    min: number,
    max: number,
    opts: BaseOpts = {},
  ) {
    if (min < 0) {
      min = 0
    }

    const indexData = await this.parse(opts)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!indexData) {
      return []
    }
    const ba = indexData.indices(refId)

    if (!ba) {
      return []
    }

    // List of bin #s that overlap min, max
    const overlappingBins = reg2bins(min, max)
    const chunks: Chunk[] = []

    // Find chunks in overlapping bins.  Leaf bins (< 4681) are not pruned
    const { binIndex } = ba
    for (const [start, end] of overlappingBins) {
      for (let bin = start; bin <= end; bin++) {
        const binChunks = binIndex[bin]
        if (binChunks) {
          for (let i = 0; i < binChunks.length; i++) {
            chunks.push(binChunks[i]!)
          }
        }
      }
    }

    // Use the linear index to find minimum file position of chunks that could
    // contain alignments in the region. Linear index entries are monotonically
    // non-decreasing, so the first entry at minLin is the minimum.
    const { linearIndex } = ba
    const nintv = linearIndex.length
    const minLin = Math.min(min >> 14, nintv - 1)
    const lowest = linearIndex[minLin]

    return optimizeChunks(chunks, lowest)
  }

  async parse(opts: BaseOpts = {}) {
    if (!this.setupP) {
      this.setupP = this._parse(opts).catch((e: unknown) => {
        this.setupP = undefined
        throw e
      })
    }
    return this.setupP
  }

  async hasRefSeq(seqId: number, opts: BaseOpts = {}) {
    const header = await this.parse(opts)
    return !!header.indices(seqId)?.binIndex
  }
}
