import {
  CIGAR_HARD_CLIP,
  CIGAR_INS,
  CIGAR_REF_SKIP,
  CIGAR_SOFT_CLIP,
} from './cigar.ts'
import Constants from './constants.ts'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const ASCII_CIGAR_CODES = [
  77, 73, 68, 78, 83, 72, 80, 61, 88, 63, 63, 63, 63, 63, 63, 63,
]

// ops that don't consume reference: INS, SOFT_CLIP, HARD_CLIP
const CIGAR_SKIP_MASK =
  (1 << CIGAR_INS) | (1 << CIGAR_SOFT_CLIP) | (1 << CIGAR_HARD_CLIP)

export interface Bytes {
  start: number
  end: number
  byteArray: Uint8Array
}

interface CIGAR_AND_LENGTH {
  length_on_ref: number
  NUMERIC_CIGAR: Uint32Array | number[]
}

export default class BamRecord {
  public fileOffset: number
  private bytes: Bytes
  private _dataView: DataView

  private _cachedFlags?: number
  private _cachedTags?: Record<string, unknown>
  private _cachedCigarAndLength?: CIGAR_AND_LENGTH
  private _cachedNUMERIC_MD?: Uint8Array | null

  constructor(args: { bytes: Bytes; fileOffset: number }) {
    this.bytes = args.bytes
    this.fileOffset = args.fileOffset
    this._dataView = new DataView(this.bytes.byteArray.buffer)
  }

  get byteArray() {
    return this.bytes.byteArray
  }

  get flags() {
    if (this._cachedFlags === undefined) {
      this._cachedFlags =
        (this._dataView.getInt32(this.bytes.start + 16, true) & 0xffff0000) >>
        16
    }
    return this._cachedFlags
  }
  get ref_id() {
    return this._dataView.getInt32(this.bytes.start + 4, true)
  }

  get start() {
    return this._dataView.getInt32(this.bytes.start + 8, true)
  }

  get end() {
    return this.start + this.length_on_ref
  }

  get mq() {
    const mq = (this.bin_mq_nl & 0xff00) >> 8
    return mq === 255 ? undefined : mq
  }

  get score() {
    return this.mq
  }

  get qual() {
    if (this.isSegmentUnmapped()) {
      return null
    } else {
      const p =
        this.b0 +
        this.read_name_length +
        this.num_cigar_bytes +
        this.num_seq_bytes
      return this.byteArray.subarray(p, p + this.seq_length)
    }
  }

  get strand() {
    return this.isReverseComplemented() ? -1 : 1
  }

  get b0() {
    return this.bytes.start + 36
  }
  get name() {
    let str = ''
    for (let i = 0; i < this.read_name_length - 1; i++) {
      str += String.fromCharCode(this.byteArray[this.b0 + i]!)
    }
    return str
  }

  get NUMERIC_MD() {
    if (this._cachedNUMERIC_MD === undefined) {
      let p =
        this.b0 +
        this.read_name_length +
        this.num_cigar_bytes +
        this.num_seq_bytes +
        this.seq_length

      const blockEnd = this.bytes.end
      const ba = this.byteArray
      while (p < blockEnd) {
        const tag1 = ba[p]!
        const tag2 = ba[p + 1]!
        const type = ba[p + 2]!
        p += 3

        // 'M' = 0x4D, 'D' = 0x44, 'Z' = 0x5A
        if (tag1 === 0x4d && tag2 === 0x44 && type === 0x5a) {
          const start = p
          while (p < blockEnd && ba[p] !== 0) {
            p++
          }
          this._cachedNUMERIC_MD = ba.subarray(start, p)
        }

        switch (type) {
          case 0x41: // 'A'
            p += 1
            break
          case 0x69: // 'i'
          case 0x49: // 'I'
          case 0x66: // 'f'
            p += 4
            break
          case 0x63: // 'c'
          case 0x43: // 'C'
            p += 1
            break
          case 0x73: // 's'
          case 0x53: // 'S'
            p += 2
            break
          case 0x5a: // 'Z'
          case 0x48: // 'H'
            while (p <= blockEnd && ba[p++] !== 0) {}
            break
          case 0x42: {
            // 'B'
            const Btype = ba[p++]!
            const limit = this._dataView.getInt32(p, true)
            p += 4
            if (Btype === 0x69 || Btype === 0x49 || Btype === 0x66) {
              p += limit << 2
            } else if (Btype === 0x73 || Btype === 0x53) {
              p += limit << 1
            } else if (Btype === 0x63 || Btype === 0x43) {
              p += limit
            }
            break
          }
        }
      }
    }
    return this._cachedNUMERIC_MD === null ? undefined : this._cachedNUMERIC_MD
  }

  get tags() {
    if (this._cachedTags === undefined) {
      this._cachedTags = this._computeTags()
    }
    return this._cachedTags
  }

  private _computeTags() {
    let p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_bytes +
      this.num_seq_bytes +
      this.seq_length

    const blockEnd = this.bytes.end
    const ba = this.byteArray
    const tags = {} as Record<string, unknown>
    while (p < blockEnd) {
      const tag = String.fromCharCode(ba[p]!, ba[p + 1]!)
      const type = ba[p + 2]!
      p += 3

      switch (type) {
        case 0x41: // 'A'
          tags[tag] = String.fromCharCode(ba[p]!)
          p += 1
          break
        case 0x69: // 'i'
          tags[tag] = this._dataView.getInt32(p, true)
          p += 4
          break
        case 0x49: // 'I'
          tags[tag] = this._dataView.getUint32(p, true)
          p += 4
          break
        case 0x63: // 'c'
          tags[tag] = this._dataView.getInt8(p)
          p += 1
          break
        case 0x43: // 'C'
          tags[tag] = this._dataView.getUint8(p)
          p += 1
          break
        case 0x73: // 's'
          tags[tag] = this._dataView.getInt16(p, true)
          p += 2
          break
        case 0x53: // 'S'
          tags[tag] = this._dataView.getUint16(p, true)
          p += 2
          break
        case 0x66: // 'f'
          tags[tag] = this._dataView.getFloat32(p, true)
          p += 4
          break
        case 0x5a: // 'Z'
        case 0x48: {
          // 'H'
          const value = []
          while (p <= blockEnd) {
            const cc = ba[p++]!
            if (cc !== 0) {
              value.push(String.fromCharCode(cc))
            } else {
              break
            }
          }
          tags[tag] = value.join('')
          break
        }
        case 0x42: {
          // 'B'
          const Btype = ba[p++]!
          const limit = this._dataView.getInt32(p, true)
          p += 4
          const absOffset = ba.byteOffset + p
          if (Btype === 0x69) {
            // 'i'
            if (absOffset % 4 === 0) {
              tags[tag] = new Int32Array(ba.buffer, absOffset, limit)
            } else {
              const bytes = ba.slice(p, p + (limit << 2))
              tags[tag] = new Int32Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 2
          } else if (Btype === 0x49) {
            // 'I'
            if (absOffset % 4 === 0) {
              tags[tag] = new Uint32Array(ba.buffer, absOffset, limit)
            } else {
              const bytes = ba.slice(p, p + (limit << 2))
              tags[tag] = new Uint32Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 2
          } else if (Btype === 0x73) {
            // 's'
            if (absOffset % 2 === 0) {
              tags[tag] = new Int16Array(ba.buffer, absOffset, limit)
            } else {
              const bytes = ba.slice(p, p + (limit << 1))
              tags[tag] = new Int16Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 1
          } else if (Btype === 0x53) {
            // 'S'
            if (absOffset % 2 === 0) {
              tags[tag] = new Uint16Array(ba.buffer, absOffset, limit)
            } else {
              const bytes = ba.slice(p, p + (limit << 1))
              tags[tag] = new Uint16Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 1
          } else if (Btype === 0x63) {
            // 'c'
            tags[tag] = new Int8Array(ba.buffer, absOffset, limit)
            p += limit
          } else if (Btype === 0x43) {
            // 'C'
            tags[tag] = new Uint8Array(ba.buffer, absOffset, limit)
            p += limit
          } else if (Btype === 0x66) {
            // 'f'
            if (absOffset % 4 === 0) {
              tags[tag] = new Float32Array(ba.buffer, absOffset, limit)
            } else {
              const bytes = ba.slice(p, p + (limit << 2))
              tags[tag] = new Float32Array(
                bytes.buffer,
                bytes.byteOffset,
                limit,
              )
            }
            p += limit << 2
          }
          break
        }
        default:
          console.error('Unknown BAM tag type', type)
          break
      }
    }
    return tags
  }

  isPaired() {
    return !!(this.flags & Constants.BAM_FPAIRED)
  }

  isProperlyPaired() {
    return !!(this.flags & Constants.BAM_FPROPER_PAIR)
  }

  isSegmentUnmapped() {
    return !!(this.flags & Constants.BAM_FUNMAP)
  }

  isMateUnmapped() {
    return !!(this.flags & Constants.BAM_FMUNMAP)
  }

  isReverseComplemented() {
    return !!(this.flags & Constants.BAM_FREVERSE)
  }

  isMateReverseComplemented() {
    return !!(this.flags & Constants.BAM_FMREVERSE)
  }

  isRead1() {
    return !!(this.flags & Constants.BAM_FREAD1)
  }

  isRead2() {
    return !!(this.flags & Constants.BAM_FREAD2)
  }

  isSecondary() {
    return !!(this.flags & Constants.BAM_FSECONDARY)
  }

  isFailedQc() {
    return !!(this.flags & Constants.BAM_FQCFAIL)
  }

  isDuplicate() {
    return !!(this.flags & Constants.BAM_FDUP)
  }

  isSupplementary() {
    return !!(this.flags & Constants.BAM_FSUPPLEMENTARY)
  }

  get cigarAndLength() {
    if (this._cachedCigarAndLength === undefined) {
      this._cachedCigarAndLength = this._computeCigarAndLength()
    }
    return this._cachedCigarAndLength
  }

  // Benchmark results for CIGAR parsing strategies (see benchmarks/cigar-lifecycle.bench.ts):
  //
  // Aligned data:
  //   - Plain array is 1.6-1.8x faster than Uint32Array for small CIGARs (≤50 ops)
  //   - Uint32Array view is 1.3-2.2x faster for large CIGARs (≥200 ops)
  //   - Crossover point is around 50-100 ops
  //
  // Unaligned data (requires slice+copy for Uint32Array):
  //   - Plain array is 3.7-6.1x faster for typical sizes (50-200 ops)
  //   - Plain array is 9-10x faster for small CIGARs (1-7 ops)
  //   - Uint32Array slice+copy only wins at extreme sizes (10000 ops: 1.4x faster)
  //
  // Strategy: use plain array for small aligned (<= 50 ops) and all unaligned,
  // Uint32Array view only for large aligned CIGARs.
  private _computeCigarAndLength() {
    if (this.isSegmentUnmapped()) {
      return {
        length_on_ref: 0,
        NUMERIC_CIGAR: new Uint32Array(0),
      }
    }

    const numCigarOps = this.num_cigar_ops
    let p = this.b0 + this.read_name_length

    // check for CG tag by inspecting whether the CIGAR field contains a clip
    // that consumes entire seqLen
    const cigop = this._dataView.getInt32(p, true)
    const lop = cigop >> 4
    const op = cigop & 0xf
    if (op === CIGAR_SOFT_CLIP && lop === this.seq_length) {
      // if there is a CG the second CIGAR field will be a N tag the represents
      // the length on ref
      p += 4
      const cigop = this._dataView.getInt32(p, true)
      const lop = cigop >> 4
      const op = cigop & 0xf
      if (op !== CIGAR_REF_SKIP) {
        console.warn('CG tag with no N tag')
      }
      const cgArray = this.tags.CG as Uint32Array
      return {
        NUMERIC_CIGAR: cgArray,
        length_on_ref: lop,
      }
    }

    const absOffset = this.byteArray.byteOffset + p
    const isAligned = absOffset % 4 === 0

    if (isAligned && numCigarOps > 50) {
      const cigarView = new Uint32Array(
        this.byteArray.buffer,
        absOffset,
        numCigarOps,
      )
      let lref = 0
      for (let c = 0; c < numCigarOps; ++c) {
        const cigop = cigarView[c]!
        const op = cigop & 0xf
        if (!((1 << op) & CIGAR_SKIP_MASK)) {
          lref += cigop >> 4
        }
      }
      return {
        NUMERIC_CIGAR: cigarView,
        length_on_ref: lref,
      }
    }

    const cigarArray: number[] = new Array(numCigarOps)
    let lref = 0
    for (let c = 0; c < numCigarOps; ++c) {
      const cigop = this._dataView.getInt32(p + c * 4, true)
      cigarArray[c] = cigop
      const op = cigop & 0xf
      if (!((1 << op) & CIGAR_SKIP_MASK)) {
        lref += cigop >> 4
      }
    }
    return {
      NUMERIC_CIGAR: cigarArray,
      length_on_ref: lref,
    }
  }

  get length_on_ref() {
    return this.cigarAndLength.length_on_ref
  }

  get NUMERIC_CIGAR() {
    return this.cigarAndLength.NUMERIC_CIGAR
  }

  get CIGAR() {
    const numeric = this.NUMERIC_CIGAR
    let result = ''
    for (let i = 0, l = numeric.length; i < l; i++) {
      const packed = numeric[i]!
      const length = packed >> 4
      const opCode = ASCII_CIGAR_CODES[packed & 0xf]!
      result += length + String.fromCharCode(opCode)
    }
    return result
  }

  get num_cigar_ops() {
    return this.flag_nc & 0xffff
  }

  get num_cigar_bytes() {
    return this.num_cigar_ops << 2
  }

  get read_name_length() {
    return this.bin_mq_nl & 0xff
  }

  get num_seq_bytes() {
    return (this.seq_length + 1) >> 1
  }

  get NUMERIC_SEQ() {
    const p = this.b0 + this.read_name_length + this.num_cigar_bytes
    return this.byteArray.subarray(p, p + this.num_seq_bytes)
  }

  get seq() {
    const numeric = this.NUMERIC_SEQ
    const len = this.seq_length
    const buf = new Array(len)
    let i = 0
    const fullBytes = len >> 1

    for (let j = 0; j < fullBytes; ++j) {
      const sb = numeric[j]!
      buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
      buf[i++] = SEQRET_DECODER[sb & 0x0f]
    }

    if (i < len) {
      const sb = numeric[fullBytes]!
      buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    }

    return buf.join('')
  }

  // adapted from igv.js
  get pair_orientation() {
    if (
      !this.isSegmentUnmapped() &&
      !this.isMateUnmapped() &&
      this.ref_id === this.next_refid
    ) {
      const s1 = this.isReverseComplemented() ? 'R' : 'F'
      const s2 = this.isMateReverseComplemented() ? 'R' : 'F'
      let o1 = ' '
      let o2 = ' '
      if (this.isRead1()) {
        o1 = '1'
        o2 = '2'
      } else if (this.isRead2()) {
        o1 = '2'
        o2 = '1'
      }

      const tmp = []
      const isize = this.template_length
      if (isize > 0) {
        tmp[0] = s1
        tmp[1] = o1
        tmp[2] = s2
        tmp[3] = o2
      } else {
        tmp[2] = s1
        tmp[3] = o1
        tmp[0] = s2
        tmp[1] = o2
      }
      return tmp.join('')
    }
    return undefined
  }

  get bin_mq_nl() {
    return this._dataView.getInt32(this.bytes.start + 12, true)
  }

  get flag_nc() {
    return this._dataView.getInt32(this.bytes.start + 16, true)
  }

  get seq_length() {
    return this._dataView.getInt32(this.bytes.start + 20, true)
  }

  get next_refid() {
    return this._dataView.getInt32(this.bytes.start + 24, true)
  }

  get next_pos() {
    return this._dataView.getInt32(this.bytes.start + 28, true)
  }

  get template_length() {
    return this._dataView.getInt32(this.bytes.start + 32, true)
  }

  seqAt(idx: number): string | undefined {
    if (idx < this.seq_length) {
      const byteIndex = idx >> 1
      const sb =
        this.byteArray[
          this.b0 + this.read_name_length + this.num_cigar_bytes + byteIndex
        ]!

      return idx % 2 === 0
        ? SEQRET_DECODER[(sb & 0xf0) >> 4]
        : SEQRET_DECODER[sb & 0x0f]
    } else {
      return undefined
    }
  }

  toJSON() {
    const data: Record<string, any> = {}
    for (const k of Object.keys(this)) {
      if (k.startsWith('_') || k === 'bytes') {
        continue
      }
      // @ts-ignore
      data[k] = this[k]
    }

    return data
  }
}
