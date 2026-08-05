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
const BAI_DEPTH = 5
// Highest coordinate the scheme addresses: the deepest level's bins are
// BAI_LINEAR_INTERVAL wide and there are 8^BAI_DEPTH of them.
const BAI_MAX_POS = 2 ** (BAI_LINEAR_SHIFT + BAI_DEPTH * 3) // 2^29

function roundDown(n: number, multiple: number) {
  return n - (n % multiple)
}
// Note the `rem === 0` case: without it a coordinate already on a window
// boundary rounds up a whole extra window, which is enough to push indexCov's
// range past the end of the linear index.
function roundUp(n: number, multiple: number) {
  const rem = n % multiple
  return rem === 0 ? n : n - rem + multiple
}

export interface IndexCovEntry {
  start: number
  end: number
  score: number
}

// Compute bin ranges that overlap [beg, end). Each level's first-bin offset
// is (8^L - 1) / 7. See SAMv1.pdf §5.1.1 for the binning derivation.
function reg2bins(beg: number, end: number) {
  // Clamp to what the scheme can address, the way CSI's reg2bins clamps to
  // its own. The shifts below are the `>>` operator, so a coordinate past
  // 2^31 wraps to a negative bin number and every level yields an empty
  // range: `getRecordsForRange(chr, 0, 2**32)` — a caller asking for a whole
  // reference without knowing its length — came back with NO records at all
  // rather than all of them. Clamping is also what keeps a merely-large end
  // from walking ~130k absent bin numbers before finding the same chunks.
  if (beg > BAI_MAX_POS) {
    beg = BAI_MAX_POS
  }
  if (end > BAI_MAX_POS) {
    end = BAI_MAX_POS
  }
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
    const binLimit = ((1 << ((BAI_DEPTH + 1) * 3)) - 1) / 7

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
          // 16 bytes per chunk (two virtual offsets); the first pass only
          // needs to step over them. Same shape as csi.ts's first pass.
          curr += 4 + 16 * chunkCount
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
    // The linear index describes [0, indexEnd): each window's score is the gap
    // to the NEXT entry, so the final entry is a boundary rather than a window
    // of its own. Both ends are clamped to it instead of throwing, so a range
    // query returns the part of the reference the index covers — asking for the
    // whole reference by its length (`indexCov(ref, 0, ctgLength)`, the obvious
    // call, and one where end lands in the last window) used to throw "query
    // outside of range of linear index" while `indexCov(ref)` answered fine.
    const indexEnd = (nintv - 1) * v
    const s =
      start === undefined
        ? 0
        : Math.min(Math.max(roundDown(start, v), 0), indexEnd)
    const e = end === undefined ? indexEnd : Math.min(roundUp(end, v), indexEnd)
    if (e <= s) {
      return []
    }
    const depths: IndexCovEntry[] = new Array((e - s) / v)
    const totalSize = linearBlockPositions[nintv - 1]!
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
