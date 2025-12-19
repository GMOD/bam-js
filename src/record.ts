import { CIGAR_REF_SKIP, CIGAR_SOFT_CLIP } from './cigar.ts'
import Constants from './constants.ts'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const ASCII_CIGAR_CODES = [
  77, 73, 68, 78, 83, 72, 80, 61, 88, 63, 63, 63, 63, 63, 63, 63,
]

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
  private bytes: Bytes
  private _dataView: DataView

  private _cachedFlags?: number
  private _cachedRefId?: number
  private _cachedStart?: number
  private _cachedEnd?: number
  private _cachedTags?: Record<string, unknown>
  private _cachedCigarAndLength?: CIGAR_AND_LENGTH
  private _cachedNUMERIC_MD?: Uint8Array | null
  private _cachedTagsStart?: number

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
    if (this._cachedRefId === undefined) {
      this._cachedRefId = this._dataView.getInt32(this.bytes.start + 4, true)
    }
    return this._cachedRefId
  }

  get start() {
    if (this._cachedStart === undefined) {
      this._cachedStart = this._dataView.getInt32(this.bytes.start + 8, true)
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

  get tagsStart() {
    if (this._cachedTagsStart === undefined) {
      this._cachedTagsStart =
        this.b0 +
        this.read_name_length +
        this.num_cigar_bytes +
        this.num_seq_bytes +
        this.seq_length
    }
    return this._cachedTagsStart
  }
  // batch fromCharCode: fastest for typical name lengths (see benchmarks/string-building.bench.ts)
  get name() {
    const len = this.read_name_length - 1
    const start = this.b0
    const ba = this.byteArray
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

    const blockEnd = this.bytes.end
    const ba = this.byteArray
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
            const value = []
            for (let i = start; i < p; i++) {
              value.push(String.fromCharCode(ba[i]!))
            }
            return value.join('')
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
          if (Btype === 0x69) {
            // 'i'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getInt32(p + i * 4, true)
            }
            tags[tag] = arr
            p += limit << 2
          } else if (Btype === 0x49) {
            // 'I'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getUint32(p + i * 4, true)
            }
            tags[tag] = arr
            p += limit << 2
          } else if (Btype === 0x73) {
            // 's'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getInt16(p + i * 2, true)
            }
            tags[tag] = arr
            p += limit << 1
          } else if (Btype === 0x53) {
            // 'S'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getUint16(p + i * 2, true)
            }
            tags[tag] = arr
            p += limit << 1
          } else if (Btype === 0x63) {
            // 'c'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getInt8(p + i)
            }
            tags[tag] = arr
            p += limit
          } else if (Btype === 0x43) {
            // 'C'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getUint8(p + i)
            }
            tags[tag] = arr
            p += limit
          } else if (Btype === 0x66) {
            // 'f'
            const arr: number[] = new Array(limit)
            for (let i = 0; i < limit; i++) {
              arr[i] = this._dataView.getFloat32(p + i * 4, true)
            }
            tags[tag] = arr
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
  // Using |0 to force 32-bit integers in plain array path:
  //   - 1.67x faster for medium CIGARs (50 ops)
  //   - Neutral for small CIGARs (1-7 ops)
  //
  // Strategy: use plain array with |0 for small aligned (≤50 ops) and all unaligned,
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
        lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
      }
      return {
        NUMERIC_CIGAR: cigarView,
        length_on_ref: lref,
      }
    }

    const cigarArray: number[] = new Array(numCigarOps)
    let lref = 0
    for (let c = 0; c < numCigarOps; ++c) {
      const cigop = this._dataView.getInt32(p + c * 4, true) | 0
      cigarArray[c] = cigop
      lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
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
  // uses template literal instead of array+join (6.4x faster, see benchmarks/string-building.bench.ts)
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

      return this.template_length > 0
        ? `${s1}${o1}${s2}${o2}`
        : `${s2}${o2}${s1}${o1}`
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
