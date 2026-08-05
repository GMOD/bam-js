import { unzip } from '@gmod/bgzf-filehandle'

import Chunk from './chunk.ts'
import IndexFile, { memoizeByRefId } from './indexFile.ts'
import {
  clampChunkEnds,
  minVirtualOffset,
  parseNameBytes,
  parsePseudoBin,
} from './util.ts'
import { VirtualOffset, fromBytes } from './virtualOffset.ts'

import type { BaseOpts } from './util.ts'

const CSI1_MAGIC = 21582659 // CSI\1
const CSI2_MAGIC = 38359875 // CSI\2

const ZERO_OFFSET = new VirtualOffset(0, 0)

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

  // CSI omits the linear index that BAI's indexCov derives coverage from
  // (CSIv1.tex §3, hts-specs), so there's no equivalent to return.
  async indexCov() {
    return []
  }

  parseAuxData(bytes: Uint8Array, offset: number) {
    const dataView = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    )
    const formatFlags = dataView.getUint32(offset, true)
    const coordinateType =
      formatFlags & 0x10000 ? 'zero-based-half-open' : '1-based-closed'
    const format = ['generic', 'SAM', 'VCF'][formatFlags & 0xf]
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
  async _parse(opts: BaseOpts) {
    const buffer = await this.filehandle.readFile(opts)
    const bytes = await unzip(buffer)

    const dataView = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    )
    // CSI\1 and CSI\2 are parsed identically here — v2 only adds fields this
    // reader doesn't consume — so the version is validated, not retained.
    const magic = dataView.getUint32(0, true)
    if (magic !== CSI1_MAGIC && magic !== CSI2_MAGIC) {
      // TODO: do we need to support big-endian CSI files?
      throw new Error(`Not a CSI file ${magic}`)
    }

    this.minShift = dataView.getInt32(4, true)
    this.depth = dataView.getInt32(8, true)
    this.maxBinNumber = ((1 << ((this.depth + 1) * 3)) - 1) / 7
    const maxBinNumber = this.maxBinNumber
    const auxLength = dataView.getInt32(12, true)
    const aux = auxLength >= 30 ? this.parseAuxData(bytes, 16) : undefined
    const refCount = dataView.getInt32(16 + auxLength, true)

    // SYNC: ~/src/gmod/tabix-js/src/csi.ts _parse — two-pass structure
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
          // A bin's loffset is the smallest virtual offset of any record in it,
          // so the minimum over loffsets is already the minimum over the bin's
          // chunks — one read per bin instead of one per chunk. Checked against
          // every .csi in test/data: same answer on all 19.
          firstDataLine = minVirtualOffset(bytes, curr, 1, firstDataLine)
          curr += 8 // loffset
          const chunkCount = dataView.getInt32(curr, true)
          curr += 4 + 16 * chunkCount
        }
      }
    }

    function getIndices(refId: number) {
      let curr = offsets[refId]
      if (curr === undefined) {
        return undefined
      }
      // the binning index
      const binCount = dataView.getInt32(curr, true)
      curr += 4
      const binIndex: Record<number, Chunk[]> = {}
      let pseudoBinStats
      for (let j = 0; j < binCount; j++) {
        const bin = dataView.getUint32(curr, true)
        curr += 4
        if (bin > maxBinNumber) {
          pseudoBinStats = parsePseudoBin(bytes, curr + 28)
          curr += 28 + 16
        } else {
          curr += 8 // skip loffset; firstDataLine was computed in the first pass
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

      clampChunkEnds(Object.values(binIndex).flat())
      return {
        binIndex,
        stats: pseudoBinStats,
      }
    }

    return {
      firstDataLine,
      indices: memoizeByRefId(getIndices),
      refCount,
      csi: true,
      ...aux,
    }
  }

  // CSI has no linear index — every refId starts from the beginning of file.
  protected getLowestChunk() {
    return ZERO_OFFSET
  }

  /**
   * calculate the list of bins that may overlap with region [beg,end)
   * (zero-based half-open). Follows the reference implementation in hts-specs
   * CSIv1.tex.
   */
  // SYNC: ~/src/gmod/tabix-js/src/csi.ts reg2bins
  protected reg2bins(beg: number, end: number) {
    // Clamp end to the maximum coordinate the index can address. With minShift
    // and depth, the index covers positions in [0, 2^(minShift + depth*3)).
    const maxPos = 2 ** (this.minShift + this.depth * 3)
    if (end > maxPos) {
      end = maxPos
    }
    end -= 1
    let l = 0
    let t = 0
    let s = this.minShift + this.depth * 3
    const bins = []
    for (; l <= this.depth; s -= 3, t += lshift(1, l * 3), l += 1) {
      const b = t + rshift(beg, s)
      const e = t + rshift(end, s)
      // Unreachable as long as the clamp above stands, which is why it shows
      // as uncovered: with end bounded to 2^(minShift + depth*3), level l
      // spans at most 8^l - 1 bins, so the worst case is 8^depth - 1 + depth
      // against a maxBinNumber of (8^(depth+1) - 1)/7, i.e. about 1.14 * 8^depth.
      // Kept as a guard on the arithmetic rather than deleted — reg2bins is
      // shared with tabix-js, whose callers reach it by other routes.
      if (e - b + bins.length > this.maxBinNumber) {
        throw new Error(
          `query ${beg}-${end} is too large for current binning scheme (shift ${this.minShift}, depth ${this.depth}), try a smaller query or a coarser index binning scheme`,
        )
      }
      bins.push([b, e] as const)
    }
    return bins
  }
}
