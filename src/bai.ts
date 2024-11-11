import Long from 'long'
import VirtualOffset, { fromBytes } from './virtualOffset'
import Chunk from './chunk'

import IndexFile from './indexFile'
import { optimizeChunks, BaseOpts, parsePseudoBin } from './util'

const BAI_MAGIC = 21578050 // BAI\1

function roundDown(n: number, multiple: number) {
  return n - (n % multiple)
}
function roundUp(n: number, multiple: number) {
  return n - (n % multiple) + multiple
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
  baiP?: Promise<Buffer>

  async lineCount(refId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return indexData.indices[refId]?.stats?.lineCount || 0
  }

  // fetch and parse the index
  async _parse(opts?: BaseOpts) {
    const bytes = (await this.filehandle.readFile(opts)) as Buffer
    const data: { [key: string]: any } = { bai: true, maxBlockSize: 1 << 16 }

    // check BAI magic numbers
    if (bytes.readUInt32LE(0) !== BAI_MAGIC) {
      throw new Error('Not a BAI file')
    }

    data.refCount = bytes.readInt32LE(4)
    const depth = 5
    const binLimit = ((1 << ((depth + 1) * 3)) - 1) / 7

    // read the indexes for each reference sequence
    data.indices = new Array(data.refCount)
    let currOffset = 8
    for (let i = 0; i < data.refCount; i += 1) {
      // the binning index
      const binCount = bytes.readInt32LE(currOffset)
      let stats

      currOffset += 4
      const binIndex: { [key: number]: Chunk[] } = {}
      for (let j = 0; j < binCount; j += 1) {
        const bin = bytes.readUInt32LE(currOffset)
        currOffset += 4
        if (bin === binLimit + 1) {
          currOffset += 4
          stats = parsePseudoBin(bytes, currOffset)
          currOffset += 32
        } else if (bin > binLimit + 1) {
          throw new Error('bai index contains too many bins, please use CSI')
        } else {
          const chunkCount = bytes.readInt32LE(currOffset)
          currOffset += 4
          const chunks = new Array(chunkCount)
          for (let k = 0; k < chunkCount; k += 1) {
            const u = fromBytes(bytes, currOffset)
            const v = fromBytes(bytes, currOffset + 8)
            currOffset += 16
            this._findFirstData(data, u)
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      const linearCount = bytes.readInt32LE(currOffset)
      currOffset += 4
      // as we're going through the linear index, figure out
      // the smallest virtual offset in the indexes, which
      // tells us where the BAM header ends
      const linearIndex = new Array(linearCount)
      for (let k = 0; k < linearCount; k += 1) {
        linearIndex[k] = fromBytes(bytes, currOffset)
        currOffset += 8
        this._findFirstData(data, linearIndex[k])
      }

      data.indices[i] = { binIndex, linearIndex, stats }
    }

    return data
  }

  async indexCov(
    seqId: number,
    start?: number,
    end?: number,
    opts: BaseOpts = {},
  ): Promise<{ start: number; end: number; score: number }[]> {
    const v = 16384
    const range = start !== undefined
    const indexData = await this.parse(opts)
    const seqIdx = indexData.indices[seqId]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

    const totalSize = linearIndex[linearIndex.length - 1].blockPosition
    if (e > (linearIndex.length - 1) * v) {
      throw new Error('query outside of range of linear index')
    }
    let currentPos = linearIndex[s / v].blockPosition
    for (let i = s / v, j = 0; i < e / v; i++, j++) {
      depths[j] = {
        score: linearIndex[i + 1].blockPosition - currentPos,
        start: i * v,
        end: i * v + v,
      }
      currentPos = linearIndex[i + 1].blockPosition
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
    const ba = indexData.indices[refId]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!ba) {
      return []
    }

    // List of bin #s that overlap min, max
    const overlappingBins = reg2bins(min, max)
    const chunks: Chunk[] = []

    // Find chunks in overlapping bins.  Leaf bins (< 4681) are not pruned
    for (const [start, end] of overlappingBins) {
      for (let bin = start; bin <= end; bin++) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (ba.binIndex[bin]) {
          const binChunks = ba.binIndex[bin]

          for (const binChunk of binChunks) {
            chunks.push(binChunk)
          }
        }
      }
    }

    // Use the linear index to find minimum file position of chunks that could
    // contain alignments in the region
    const nintv = ba.linearIndex.length
    let lowest: VirtualOffset | undefined
    const minLin = Math.min(min >> 14, nintv - 1)
    const maxLin = Math.min(max >> 14, nintv - 1)
    for (let i = minLin; i <= maxLin; ++i) {
      const vp = ba.linearIndex[i]
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (vp && (!lowest || vp.compareTo(lowest) < 0)) {
        lowest = vp
      }
    }

    return optimizeChunks(chunks, lowest)
  }
}
