import * as Long from 'long'
import { fromBytes } from './virtualOffset'
import Chunk from './chunk'

import IndexFile from './indexFile'

const BAI_MAGIC = 21578050 // BAI\1
const { longToNumber, abortBreakPoint, canMergeBlocks } = require('./util')

function roundDown(n, multiple) {
  return n - (n % multiple)
}
function roundUp(n, multiple) {
  return n - (n % multiple) + multiple
}

export default class BAI extends IndexFile {
  parsePseudoBin(bytes, offset) {
    const lineCount = longToNumber(
      Long.fromBytesLE(bytes.slice(offset + 16, offset + 24), true),
    )
    return { lineCount }
  }

  async lineCount(refId) {
    const index = (await this.parse()).indices[refId]
    if (!index) {
      return -1
    }
    const ret = index.stats || {}
    return ret.lineCount === undefined ? -1 : ret.lineCount
  }

  // fetch and parse the index
  async _parse(abortSignal) {
    const data = { bai: true, maxBlockSize: 1 << 16 }
    const bytes = await this.filehandle.readFile({ signal: abortSignal })

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
      await abortBreakPoint(abortSignal)

      // the binning index
      const binCount = bytes.readInt32LE(currOffset)
      let stats

      currOffset += 4
      const binIndex = {}
      for (let j = 0; j < binCount; j += 1) {
        const bin = bytes.readUInt32LE(currOffset)
        currOffset += 4
        if (bin === binLimit + 1) {
          currOffset += 4
          stats = this.parsePseudoBin(bytes, currOffset)
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

  async indexCov(seqId, start, end) {
    const v = 16384
    const range = start !== undefined
    const indexData = await this.parse()
    const seqIdx = indexData.indices[seqId]
    if (!seqIdx) return []
    const { linearIndex = [], stats } = seqIdx
    if (!linearIndex.length) return []
    const e = range ? roundUp(end, v) : (linearIndex.length - 1) * v
    const s = range ? roundDown(start, v) : 0
    let depths
    if (range) {
      depths = new Array(Math.floor((e - s) / v))
    } else {
      depths = new Array(linearIndex.length - 1)
    }
    const totalSize = linearIndex[linearIndex.length - 1].blockPosition
    if (e > (linearIndex.length - 1) * v) {
      throw new Error('query outside of range of linear index')
    }
    let currentPos = linearIndex[s / v].blockPosition
    for (let i = s / v, j = 0; i + 1 < e / v; i++, j++) {
      depths[j] = {
        score: linearIndex[i + 1].blockPosition - currentPos,
        start: i * v,
        end: i * v + v,
      }
      currentPos = linearIndex[i + 1].blockPosition
    }
    return depths.map(d => {
      return { ...d, score: (d.score * stats.lineCount) / totalSize }
    })
  }

  async indexCovTotal(seqId) {
    const v = 16384
    const indexData = await this.parse()
    const seqIdx = indexData.indices[seqId]
    if (!seqIdx) return []
    const { linearIndex = [], stats } = seqIdx
    if (!linearIndex.length) return []
    let currentPos = linearIndex[0].blockPosition
    const depths = new Array(linearIndex.length - 1)
    const totalSize = linearIndex.slice(-1)[0].blockPosition
    for (let i = 1, j = 0; i < linearIndex.length; i++, j++) {
      depths[j] = linearIndex[i].blockPosition - currentPos
      currentPos = linearIndex[i].blockPosition
    }
    return depths.map((d, i) => {
      return {
        score: (d * stats.lineCount) / totalSize,
        start: i * v,
        end: i * v + v,
      }
    })
  }

  async blocksForRange(refId, beg, end) {
    if (beg < 0) beg = 0

    const indexData = await this.parse()
    if (!indexData) return []
    const indexes = indexData.indices[refId]
    if (!indexes) return []

    const { binIndex } = indexes

    const bins = this.reg2bins(beg, end)

    let l
    let numOffsets = 0
    for (let i = 0; i < bins.length; i += 1) {
      if (binIndex[bins[i]]) {
        numOffsets += binIndex[bins[i]].length
      }
    }

    if (numOffsets === 0) return []

    let off = []
    numOffsets = 0
    for (let i = 0; i < bins.length; i += 1) {
      const chunks = binIndex[bins[i]]
      if (chunks)
        for (let j = 0; j < chunks.length; j += 1) {
          off[numOffsets] = new Chunk(
            chunks[j].minv,
            chunks[j].maxv,
            chunks[j].bin,
          )
          numOffsets += 1
        }
    }

    if (!off.length) return []

    off = off.sort((a, b) => a.compareTo(b))
    // resolve overlaps between adjacent blocks; this may happen due to the merge in indexing
    for (let i = 1; i < numOffsets; i += 1)
      if (off[i - 1].maxv.compareTo(off[i].minv) >= 0)
        off[i - 1].maxv = off[i].minv

    // merge adjacent blocks
    l = 0
    for (let i = 1; i < numOffsets; i += 1) {
      if (canMergeBlocks(off[l], off[i])) off[l].maxv = off[i].maxv
      else {
        l += 1
        off[l].minv = off[i].minv
        off[l].maxv = off[i].maxv
      }
    }
    numOffsets = l + 1

    return off.slice(0, numOffsets)
  }

  /**
   * calculate the list of bins that may overlap with region [beg,end) (zero-based half-open)
   * @returns {Array[number]}
   */
  reg2bins(beg, end) {
    const list = [0]
    end -= 1
    for (let k = 1 + (beg >> 26); k <= 1 + (end >> 26); k += 1) list.push(k)
    for (let k = 9 + (beg >> 23); k <= 9 + (end >> 23); k += 1) list.push(k)
    for (let k = 73 + (beg >> 20); k <= 73 + (end >> 20); k += 1) list.push(k)
    for (let k = 585 + (beg >> 17); k <= 585 + (end >> 17); k += 1) list.push(k)
    for (let k = 4681 + (beg >> 14); k <= 4681 + (end >> 14); k += 1)
      list.push(k)
    return list
  }
}
