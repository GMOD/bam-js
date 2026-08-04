import Chunk from './chunk.ts'
import IndexFile, { memoizeByRefId } from './indexFile.ts'
import { clampChunkEnds, minVirtualOffset, parsePseudoBin } from './util.ts'
import { fromBytes } from './virtualOffset.ts'

import type { ParsedIndexBase, RefIndex } from './indexFile.ts'
import type { BaseOpts } from './util.ts'
import type { VirtualOffset } from './virtualOffset.ts'

// The linear index as two parallel Float64Arrays rather than an array of
// VirtualOffset objects. A human-sized reference has one entry per 16kb window
// — ~15k for chr1 — and an object apiece costs roughly an order of magnitude
// more memory than the packed form, retained for as long as memoizeByRefId
// holds the reference. Both consumers want the raw numbers anyway: indexCov and
// clampChunkEnds read blockPosition only, and getLowestChunk builds the one
// VirtualOffset a query actually needs. Same shape as bgzf-filehandle's
// GziIndex, for the same reason.
interface BaiRefIndex extends RefIndex {
  linearBlockPositions: Float64Array
  linearDataPositions: Float64Array
}

const EMPTY_POSITIONS = new Float64Array(0)

interface BaiParsed extends ParsedIndexBase<BaiRefIndex> {
  bai: true
}

const BAI_MAGIC = 21578050 // BAI\1

// BAI uses a fixed 5-level binning scheme with a 14-bit (16KB) linear index
// resolution. See SAMv1.pdf §5.1.3 (hts-specs).
// https://github.com/samtools/hts-specs/blob/master/SAMv1.pdf
const BAI_LINEAR_SHIFT = 14
const BAI_LINEAR_INTERVAL = 1 << BAI_LINEAR_SHIFT // 16384

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

// Compute bin ranges that overlap [beg, end). Each level's first-bin offset
// is (8^L - 1) / 7. See SAMv1.pdf §5.1.1 for the binning derivation.
function reg2bins(beg: number, end: number) {
  end -= 1
  return [
    [0, 0],
    [1 + (beg >> 26), 1 + (end >> 26)],
    [9 + (beg >> 23), 9 + (end >> 23)],
    [73 + (beg >> 20), 73 + (end >> 20)],
    [585 + (beg >> 17), 585 + (end >> 17)],
    [4681 + (beg >> BAI_LINEAR_SHIFT), 4681 + (end >> BAI_LINEAR_SHIFT)],
  ] as const
}

export default class BAI extends IndexFile<BaiParsed> {
  async _parse(opts: BaseOpts): Promise<BaiParsed> {
    const bytes = await this.filehandle.readFile(opts)
    const dataView = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    )

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

      // walk the linear index to find the smallest virtual offset, which
      // marks where the BAM header ends and data begins
      const linearCount = dataView.getInt32(curr, true)
      curr += 4
      firstDataLine = minVirtualOffset(bytes, curr, linearCount, firstDataLine)
      curr += 8 * linearCount
    }

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
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      const linearCount = dataView.getInt32(curr, true)
      curr += 4
      // Share one empty array rather than allocating a pair per reference. An
      // assembly with tens of thousands of unplaced scaffolds (cho.bam.bai:
      // 28751 references, 205 linear entries between them) reaches here once
      // per reference, and almost every one of those has an empty linear index.
      const linearBlockPositions =
        linearCount === 0 ? EMPTY_POSITIONS : new Float64Array(linearCount)
      const linearDataPositions =
        linearCount === 0 ? EMPTY_POSITIONS : new Float64Array(linearCount)
      for (let j = 0; j < linearCount; j++) {
        // a virtual offset is a 48-bit block position in the high bytes and a
        // 16-bit data position in the low two
        linearBlockPositions[j] =
          bytes[curr + 7]! * 0x10000000000 +
          bytes[curr + 6]! * 0x100000000 +
          bytes[curr + 5]! * 0x1000000 +
          bytes[curr + 4]! * 0x10000 +
          bytes[curr + 3]! * 0x100 +
          bytes[curr + 2]!
        linearDataPositions[j] = (bytes[curr + 1]! << 8) | bytes[curr]!
        curr += 8
      }

      clampChunkEnds(Object.values(binIndex).flat(), linearBlockPositions)
      return {
        binIndex,
        linearBlockPositions,
        linearDataPositions,
        stats,
      }
    }

    return {
      bai: true,
      firstDataLine,
      indices: memoizeByRefId(getIndices),
      refCount,
    }
  }

  async indexCov(
    seqId: number,
    start?: number,
    end?: number,
    opts?: BaseOpts,
  ): Promise<IndexCovEntry[]> {
    const v = BAI_LINEAR_INTERVAL
    const range = start !== undefined
    const indexData = await this.parse(opts)
    const seqIdx = indexData.indices(seqId)

    if (!seqIdx) {
      return []
    }
    const { linearBlockPositions, stats } = seqIdx
    const nintv = linearBlockPositions.length
    if (nintv === 0) {
      return []
    }
    const e = end === undefined ? (nintv - 1) * v : roundUp(end, v)
    const s = start === undefined ? 0 : roundDown(start, v)
    const depths: IndexCovEntry[] = range
      ? new Array((e - s) / v)
      : new Array(nintv - 1)
    const totalSize = linearBlockPositions[nintv - 1]!
    if (e > (nintv - 1) * v) {
      throw new Error('query outside of range of linear index')
    }
    // Scale the block-delta into a read count as we go, rather than building the
    // entries and then rebuilding every one of them to apply the scale. Keep the
    // multiply-then-divide order: hoisting lineCount/totalSize into a factor
    // reassociates the arithmetic and shifts scores by an ulp.
    const lineCount = stats?.lineCount ?? 0
    let currentPos = linearBlockPositions[s / v]!
    for (let i = s / v, j = 0; i < e / v; i++, j++) {
      const nextPos = linearBlockPositions[i + 1]!
      depths[j] = {
        score: ((nextPos - currentPos) * lineCount) / totalSize,
        start: i * v,
        end: i * v + v,
      }
      currentPos = nextPos
    }
    return depths
  }

  protected reg2bins(min: number, max: number) {
    return reg2bins(min, max)
  }

  // Use the linear index to find minimum file position of chunks that could
  // contain alignments in the region. Linear index entries are monotonically
  // non-decreasing, so the first entry at minLin is the minimum.
  protected getLowestChunk(refIndex: BaiRefIndex, min: number) {
    const { linearBlockPositions, linearDataPositions } = refIndex
    const i = Math.min(min >> BAI_LINEAR_SHIFT, linearBlockPositions.length - 1)
    return i < 0
      ? undefined
      : {
          blockPosition: linearBlockPositions[i]!,
          dataPosition: linearDataPositions[i]!,
        }
  }
}
