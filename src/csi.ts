import { unzip } from '@gmod/bgzf-filehandle'
import QuickLRU from 'quick-lru'

import Chunk from './chunk.ts'
import IndexFile from './indexFile.ts'
import {
  findFirstData,
  optimizeChunks,
  parseNameBytes,
  parsePseudoBin,
} from './util.ts'
import { VirtualOffset, fromBytes } from './virtualOffset.ts'

import type { BaseOpts } from './util.ts'

const CSI1_MAGIC = 21582659 // CSI\1
const CSI2_MAGIC = 38359875 // CSI\2

function lshift(num: number, bits: number) {
  return num * 2 ** bits
}
function rshift(num: number, bits: number) {
  return Math.floor(num / 2 ** bits)
}

export default class CSI extends IndexFile {
  private maxBinNumber = 0
  private depth = 0
  private minShift = 0

  public setupP?: ReturnType<CSI['_parse']>

  async lineCount(refId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return indexData.indices(refId)?.stats?.lineCount || 0
  }

  async indexCov() {
    return []
  }

  parseAuxData(bytes: Uint8Array, offset: number) {
    const dataView = new DataView(bytes.buffer)
    const formatFlags = dataView.getUint32(offset, true)
    const coordinateType =
      formatFlags & 0x10000 ? 'zero-based-half-open' : '1-based-closed'
    const format = (
      { 0: 'generic', 1: 'SAM', 2: 'VCF' } as Record<number, string>
    )[formatFlags & 0xf]
    if (!format) {
      throw new Error(`invalid Tabix preset format flags ${formatFlags}`)
    }
    const columnNumbers = {
      ref: dataView.getInt32(offset + 4, true),
      start: dataView.getInt32(offset + 8, true),
      end: dataView.getInt32(offset + 12, true),
    }
    const metaValue = dataView.getInt32(offset + 16, true)
    const metaChar = metaValue ? String.fromCharCode(metaValue) : ''
    const skipLines = dataView.getInt32(offset + 20, true)
    const nameSectionLength = dataView.getInt32(offset + 24, true)

    return {
      columnNumbers,
      coordinateType,
      metaValue,
      metaChar,
      skipLines,
      format,
      formatFlags,
      ...parseNameBytes(
        bytes.subarray(offset + 28, offset + 28 + nameSectionLength),
        this.renameRefSeq,
      ),
    }
  }

  // fetch and parse the index
  async _parse(opts: { signal?: AbortSignal }) {
    const buffer = await this.filehandle.readFile(opts)
    const bytes = await unzip(buffer)

    const dataView = new DataView(bytes.buffer)
    let csiVersion
    const magic = dataView.getUint32(0, true)

    if (magic === CSI1_MAGIC) {
      csiVersion = 1
    } else if (magic === CSI2_MAGIC) {
      csiVersion = 2
    } else {
      throw new Error(`Not a CSI file ${magic}`)
      // TODO: do we need to support big-endian CSI files?
    }

    this.minShift = dataView.getInt32(4, true)
    this.depth = dataView.getInt32(8, true)
    this.maxBinNumber = ((1 << ((this.depth + 1) * 3)) - 1) / 7
    const maxBinNumber = this.maxBinNumber
    const auxLength = dataView.getInt32(12, true)
    const aux = auxLength >= 30 ? this.parseAuxData(bytes, 16) : undefined
    const refCount = dataView.getInt32(16 + auxLength, true)

    // read the indexes for each reference sequence
    let curr = 16 + auxLength + 4
    let firstDataLine: VirtualOffset | undefined
    const offsets = [] as number[]
    for (let i = 0; i < refCount; i++) {
      offsets.push(curr)
      const binCount = dataView.getInt32(curr, true)
      curr += 4
      for (let j = 0; j < binCount; j++) {
        const bin = dataView.getUint32(curr, true)
        curr += 4
        if (bin > this.maxBinNumber) {
          curr += 28 + 16
        } else {
          curr += 8
          const chunkCount = dataView.getInt32(curr, true)
          curr += 4
          for (let k = 0; k < chunkCount; k += 1) {
            const u = fromBytes(bytes, curr)
            curr += 8
            curr += 8
            firstDataLine = findFirstData(firstDataLine, u)
          }
        }
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
      // the binning index
      const binCount = dataView.getInt32(curr, true)
      curr += 4
      const binIndex: Record<string, Chunk[]> = {}
      let pseudoBinStats
      for (let j = 0; j < binCount; j++) {
        const bin = dataView.getUint32(curr, true)
        curr += 4
        if (bin > maxBinNumber) {
          pseudoBinStats = parsePseudoBin(bytes, curr + 28)
          curr += 28 + 16
        } else {
          firstDataLine = findFirstData(firstDataLine, fromBytes(bytes, curr))
          curr += 8
          const chunkCount = dataView.getInt32(curr, true)
          curr += 4
          const chunks = new Array<Chunk>(chunkCount)
          for (let k = 0; k < chunkCount; k += 1) {
            const u = fromBytes(bytes, curr)
            curr += 8
            const v = fromBytes(bytes, curr)
            curr += 8
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      return {
        binIndex,
        stats: pseudoBinStats,
      }
    }

    return {
      csiVersion,
      firstDataLine,
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
      csi: true,
      maxBlockSize: 1 << 16,
      ...aux,
    }
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
    const ba = indexData.indices(refId)

    if (!ba) {
      return []
    }
    const overlappingBins = this.reg2bins(min, max)

    if (overlappingBins.length === 0) {
      return []
    }

    const chunks = []
    // Find chunks in overlapping bins.  Leaf bins (< 4681) are not pruned
    for (const [start, end] of overlappingBins) {
      for (let bin = start; bin <= end; bin++) {
        if (ba.binIndex[bin]) {
          const binChunks = ba.binIndex[bin]!
          for (const c of binChunks) {
            chunks.push(c)
          }
        }
      }
    }

    return optimizeChunks(chunks, new VirtualOffset(0, 0))
  }

  /**
   * calculate the list of bins that may overlap with region [beg,end)
   * (zero-based half-open)
   */
  reg2bins(beg: number, end: number) {
    beg -= 1 // < convert to 1-based closed
    if (beg < 1) {
      beg = 1
    }
    if (end > 2 ** 50) {
      end = 2 ** 34
    } // 17 GiB ought to be enough for anybody
    end -= 1
    let l = 0
    let t = 0
    let s = this.minShift + this.depth * 3
    const bins = []
    for (; l <= this.depth; s -= 3, t += lshift(1, l * 3), l += 1) {
      const b = t + rshift(beg, s)
      const e = t + rshift(end, s)
      if (e - b + bins.length > this.maxBinNumber) {
        throw new Error(
          `query ${beg}-${end} is too large for current binning scheme (shift ${this.minShift}, depth ${this.depth}), try a smaller query or a coarser index binning scheme`,
        )
      }
      bins.push([b, e] as const)
    }
    return bins
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
