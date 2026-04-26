import { CIGAR_REF_SKIP, CIGAR_SOFT_CLIP } from './cigar.ts'
import Constants from './constants.ts'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')

// precomputed pair orientation strings indexed by ((flags >> 4) & 0xF) | (isize > 0 ? 16 : 0)
// bits 0-3 encode flag bits 0x10(reverse),0x20(mate reverse),0x40(read1),0x80(read2)
// bit 4 encodes whether isize > 0
// prettier-ignore
const PAIR_ORIENTATION_TABLE = [
  'F F ','F R ','R F ','R R ','F2F1','F2R1','R2F1','R2R1',
  'F1F2','F1R2','R1F2','R1R2','F2F1','F2R1','R2F1','R2R1',
  'F F ','R F ','F R ','R R ','F1F2','R1F2','F1R2','R1R2',
  'F2F1','R2F1','F2R1','R2R1','F1F2','R1F2','F1R2','R1R2',
]
const ASCII_CIGAR_CODES = [
  77, 73, 68, 78, 83, 72, 80, 61, 88, 63, 63, 63, 63, 63, 63, 63,
]

const textDecoder = new TextDecoder()

// Bitmask for ops that consume ref: M=0, D=2, N=3, P=6, ==7, X=8
// Binary: 0b111001101 = 0x1CD
const CIGAR_CONSUMES_REF_MASK = 0x1cd

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
  private _byteArray: Uint8Array
  private _start: number
  private _end: number
  private _dataView: DataView

  private _cachedFlags?: number
  private _cachedRefId?: number
  private _cachedStart?: number
  private _cachedEnd?: number
  private _cachedTags?: Record<string, unknown>
  private _cachedLengthOnRef?: number
  private _cachedNumericCigar?: Uint32Array | number[]
  private _cachedNUMERIC_MD?: Uint8Array | null
  private _cachedTagsStart?: number

  constructor(args: { bytes: Bytes; fileOffset: number; dataView?: DataView }) {
    this._byteArray = args.bytes.byteArray
    this._start = args.bytes.start
    this._end = args.bytes.end
    this.fileOffset = args.fileOffset
    this._dataView = args.dataView ?? new DataView(this._byteArray.buffer)
  }

  get byteArray() {
    return this._byteArray
  }

  get flags() {
    if (this._cachedFlags === undefined) {
      this._cachedFlags =
        (this._dataView.getInt32(this._start + 16, true) & 0xffff0000) >> 16
    }
    return this._cachedFlags
  }

  get ref_id() {
    if (this._cachedRefId === undefined) {
      this._cachedRefId = this._dataView.getInt32(this._start + 4, true)
    }
    return this._cachedRefId
  }

  get start() {
    if (this._cachedStart === undefined) {
      this._cachedStart = this._dataView.getInt32(this._start + 8, true)
    }
    return this._cachedStart
  }

  get end() {
    if (this._cachedEnd === undefined) {
      this._cachedEnd = this.start + this.length_on_ref
    }
    return this._cachedEnd
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
      const seqLen = this.seq_length
      const p =
        this.b0 +
        this.read_name_length +
        this.num_cigar_bytes +
        ((seqLen + 1) >> 1)
      return this._byteArray.subarray(p, p + seqLen)
    }
  }

  get strand() {
    return this.isReverseComplemented() ? -1 : 1
  }

  get b0() {
    return this._start + 36
  }

  get tagsStart() {
    if (this._cachedTagsStart === undefined) {
      const seqLen = this.seq_length
      this._cachedTagsStart =
        this.b0 +
        this.read_name_length +
        this.num_cigar_bytes +
        ((seqLen + 1) >> 1) +
        seqLen
    }
    return this._cachedTagsStart
  }

  // batch fromCharCode: fastest for typical name lengths (see benchmarks/string-building.bench.ts)
  get name() {
    const len = this.read_name_length - 1
    const start = this.b0
    const ba = this._byteArray
    const codes = new Array(len)
    for (let i = 0; i < len; i++) {
      codes[i] = ba[start + i]!
    }
    return String.fromCharCode(...codes)
  }

  get NUMERIC_MD() {
    if (this._cachedNUMERIC_MD === undefined) {
      const result = this.getTagRaw('MD')
      this._cachedNUMERIC_MD = result instanceof Uint8Array ? result : null
    }
    return this._cachedNUMERIC_MD === null ? undefined : this._cachedNUMERIC_MD
  }

  get tags() {
    if (this._cachedTags === undefined) {
      this._cachedTags = this._computeTags()
    }
    return this._cachedTags
  }

  getTag(tagName: string) {
    if (this._cachedTags !== undefined) {
      return this._cachedTags[tagName]
    }
    return this._findTag(tagName, false)
  }

  getTagRaw(tagName: string) {
    return this._findTag(tagName, true)
  }

  private _findTag(tagName: string, raw: boolean) {
    const tag1 = tagName.charCodeAt(0)
    const tag2 = tagName.charCodeAt(1)

    let p = this.tagsStart

    const blockEnd = this._end
    const ba = this._byteArray
    while (p < blockEnd) {
      const currentTag1 = ba[p]!
      const currentTag2 = ba[p + 1]!
      const type = ba[p + 2]!
      p += 3

      const isMatch = currentTag1 === tag1 && currentTag2 === tag2

      switch (type) {
        case 0x41: // 'A'
          if (isMatch) {
            return String.fromCharCode(ba[p]!)
          }
          p += 1
          break
        case 0x69: // 'i'
          if (isMatch) {
            return this._dataView.getInt32(p, true)
          }
          p += 4
          break
        case 0x49: // 'I'
          if (isMatch) {
            return this._dataView.getUint32(p, true)
          }
          p += 4
          break
        case 0x63: // 'c'
          if (isMatch) {
            return this._dataView.getInt8(p)
          }
          p += 1
          break
        case 0x43: // 'C'
          if (isMatch) {
            return this._dataView.getUint8(p)
          }
          p += 1
          break
        case 0x73: // 's'
          if (isMatch) {
            return this._dataView.getInt16(p, true)
          }
          p += 2
          break
        case 0x53: // 'S'
          if (isMatch) {
            return this._dataView.getUint16(p, true)
          }
          p += 2
          break
        case 0x66: // 'f'
          if (isMatch) {
            return this._dataView.getFloat32(p, true)
          }
          p += 4
          break
        case 0x5a: // 'Z'
        case 0x48: {
          // 'H'
          if (isMatch) {
            const start = p
            while (p < blockEnd && ba[p] !== 0) {
              p++
            }
            if (raw) {
              return ba.subarray(start, p)
            }
            return textDecoder.decode(ba.subarray(start, p))
          }
          while (p <= blockEnd && ba[p++] !== 0) {}
          break
        }
        case 0x42: {
          // 'B'
          const Btype = ba[p++]!
          const limit = this._dataView.getInt32(p, true)
          p += 4
          const absOffset = ba.byteOffset + p
          if (isMatch) {
            if (Btype === 0x69) {
              // 'i'
              if (absOffset % 4 === 0) {
                return new Int32Array(ba.buffer, absOffset, limit)
              }
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getInt32(p + i * 4, true)
              }
              return arr
            } else if (Btype === 0x49) {
              // 'I'
              if (absOffset % 4 === 0) {
                return new Uint32Array(ba.buffer, absOffset, limit)
              }
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getUint32(p + i * 4, true)
              }
              return arr
            } else if (Btype === 0x73) {
              // 's'
              if (absOffset % 2 === 0) {
                return new Int16Array(ba.buffer, absOffset, limit)
              }
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getInt16(p + i * 2, true)
              }
              return arr
            } else if (Btype === 0x53) {
              // 'S'
              if (absOffset % 2 === 0) {
                return new Uint16Array(ba.buffer, absOffset, limit)
              }
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getUint16(p + i * 2, true)
              }
              return arr
            } else if (Btype === 0x63) {
              // 'c'
              return new Int8Array(ba.buffer, absOffset, limit)
            } else if (Btype === 0x43) {
              // 'C'
              return new Uint8Array(ba.buffer, absOffset, limit)
            } else if (Btype === 0x66) {
              // 'f'
              if (absOffset % 4 === 0) {
                return new Float32Array(ba.buffer, absOffset, limit)
              }
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getFloat32(p + i * 4, true)
              }
              return arr
            }
          }
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
    return undefined
  }

  private _computeTags() {
    let p = this.tagsStart

    const blockEnd = this._end
    const ba = this._byteArray
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
          const start = p
          while (p < blockEnd && ba[p] !== 0) {
            p++
          }
          tags[tag] = textDecoder.decode(ba.subarray(start, p))
          p++ // advance past null terminator
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
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getInt32(p + i * 4, true)
              }
              tags[tag] = arr
            }
            p += limit << 2
          } else if (Btype === 0x49) {
            // 'I'
            if (absOffset % 4 === 0) {
              tags[tag] = new Uint32Array(ba.buffer, absOffset, limit)
            } else {
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getUint32(p + i * 4, true)
              }
              tags[tag] = arr
            }
            p += limit << 2
          } else if (Btype === 0x73) {
            // 's'
            if (absOffset % 2 === 0) {
              tags[tag] = new Int16Array(ba.buffer, absOffset, limit)
            } else {
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getInt16(p + i * 2, true)
              }
              tags[tag] = arr
            }
            p += limit << 1
          } else if (Btype === 0x53) {
            // 'S'
            if (absOffset % 2 === 0) {
              tags[tag] = new Uint16Array(ba.buffer, absOffset, limit)
            } else {
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getUint16(p + i * 2, true)
              }
              tags[tag] = arr
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
              const arr: number[] = new Array(limit)
              for (let i = 0; i < limit; i++) {
                arr[i] = this._dataView.getFloat32(p + i * 4, true)
              }
              tags[tag] = arr
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

  // Compatibility getter — prefer length_on_ref and NUMERIC_CIGAR directly
  get cigarAndLength(): CIGAR_AND_LENGTH {
    return {
      length_on_ref: this.length_on_ref,
      NUMERIC_CIGAR: this.NUMERIC_CIGAR,
    }
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
  // Using |0 to force 32-bit integers in plain array path:
  //   - 1.67x faster for medium CIGARs (50 ops)
  //   - Neutral for small CIGARs (1-7 ops)
  //
  // Strategy: use plain array with |0 for small aligned (≤50 ops) and all unaligned,
  // Uint32Array view only for large aligned CIGARs.
  private _computeLengthOnRef(): number {
    if (this.isSegmentUnmapped()) {
      return 0
    }

    const numCigarOps = this.num_cigar_ops
    const p = this.b0 + this.read_name_length

    // CG tag: first op is soft clip consuming the entire sequence; second op is N encoding length on ref
    const cigop = this._dataView.getInt32(p, true)
    const lop = cigop >> 4
    const op = cigop & 0xf
    if (op === CIGAR_SOFT_CLIP && lop === this.seq_length) {
      const cigop2 = this._dataView.getInt32(p + 4, true)
      if ((cigop2 & 0xf) !== CIGAR_REF_SKIP) {
        console.warn('CG tag with no N tag')
      }
      return cigop2 >> 4
    }

    const absOffset = this._byteArray.byteOffset + p
    if (absOffset % 4 === 0 && numCigarOps > 50) {
      // Zero-copy view — cache NUMERIC_CIGAR as a side effect since it's free to do here
      const cigarView = new Uint32Array(
        this._byteArray.buffer,
        absOffset,
        numCigarOps,
      )
      this._cachedNumericCigar = cigarView
      let lref = 0
      for (let c = 0; c < numCigarOps; ++c) {
        const co = cigarView[c]!
        lref += (co >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (co & 0xf)) & 1)
      }
      return lref
    }

    let lref = 0
    for (let c = 0; c < numCigarOps; ++c) {
      const co = this._dataView.getInt32(p + c * 4, true)
      lref += (co >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (co & 0xf)) & 1)
    }
    return lref
  }

  private _computeNumericCigar(): Uint32Array | number[] {
    if (this.isSegmentUnmapped()) {
      return new Uint32Array(0)
    }

    const numCigarOps = this.num_cigar_ops
    const p = this.b0 + this.read_name_length

    const cigop = this._dataView.getInt32(p, true)
    const lop = cigop >> 4
    const op = cigop & 0xf
    if (op === CIGAR_SOFT_CLIP && lop === this.seq_length) {
      return (this.tags.CG as Uint32Array | undefined) ?? new Uint32Array(0)
    }

    const absOffset = this._byteArray.byteOffset + p
    if (absOffset % 4 === 0 && numCigarOps > 50) {
      return new Uint32Array(this._byteArray.buffer, absOffset, numCigarOps)
    }

    const cigarArray: number[] = new Array(numCigarOps)
    for (let c = 0; c < numCigarOps; ++c) {
      cigarArray[c] = this._dataView.getInt32(p + c * 4, true) | 0
    }
    return cigarArray
  }

  get length_on_ref() {
    if (this._cachedLengthOnRef === undefined) {
      this._cachedLengthOnRef = this._computeLengthOnRef()
    }
    return this._cachedLengthOnRef
  }

  get NUMERIC_CIGAR() {
    if (this._cachedNumericCigar === undefined) {
      this._cachedNumericCigar = this._computeNumericCigar()
    }
    return this._cachedNumericCigar
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
    return this._byteArray.subarray(p, p + this.num_seq_bytes)
  }

  get seq() {
    const len = this.seq_length
    const seqStart = this.b0 + this.read_name_length + this.num_cigar_bytes
    const numeric = this._byteArray
    const buf = new Array(len)
    let i = 0
    const fullBytes = len >> 1

    for (let j = 0; j < fullBytes; ++j) {
      const sb = numeric[seqStart + j]!
      buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
      buf[i++] = SEQRET_DECODER[sb & 0x0f]
    }

    if (i < len) {
      const sb = numeric[seqStart + fullBytes]!
      buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    }

    return buf.join('')
  }

  // adapted from igv.js
  // uses precomputed lookup table indexed by flag bits + isize sign.
  // the BAM spec defines tlen as positive for the leftmost segment and
  // negative for the rightmost, so tlen > 0 reliably indicates which
  // read comes first without needing position-based correction
  // (see also: gmod/cram-js src/cramFile/record.ts getPairOrientation)
  get pair_orientation() {
    const f = this.flags
    // unmapped (0x4) or mate unmapped (0x8) -> undefined
    if (f & 0xc || this.ref_id !== this.next_refid) {
      return undefined
    }
    return PAIR_ORIENTATION_TABLE[
      ((f >> 4) & 0xf) | (this.template_length > 0 ? 16 : 0)
    ]
  }

  get bin_mq_nl() {
    return this._dataView.getInt32(this._start + 12, true)
  }

  get flag_nc() {
    return this._dataView.getInt32(this._start + 16, true)
  }

  get seq_length() {
    return this._dataView.getInt32(this._start + 20, true)
  }

  get next_refid() {
    return this._dataView.getInt32(this._start + 24, true)
  }

  get next_pos() {
    return this._dataView.getInt32(this._start + 28, true)
  }

  get template_length() {
    return this._dataView.getInt32(this._start + 32, true)
  }

  seqAt(idx: number): string | undefined {
    if (idx < this.seq_length) {
      const byteIndex = idx >> 1
      const sb =
        this._byteArray[
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
    const data: Record<string, unknown> = {}
    for (const k of Object.keys(this)) {
      if (k.startsWith('_')) {
        continue
      }
      // @ts-ignore
      data[k] = this[k]
    }

    return data
  }
}
