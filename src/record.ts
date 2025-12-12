import Constants from './constants.ts'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const ASCII_CIGAR_CODES = [
  77, 73, 68, 78, 83, 72, 80, 61, 88, 63, 63, 63, 63, 63, 63, 63,
]

// const CIGAR_MATCH = 0
const CIGAR_INS = 1
// const CIGAR_DEL = 2
const CIGAR_REF_SKIP = 3
const CIGAR_SOFT_CLIP = 4
const CIGAR_HARD_CLIP = 5
// const CIGAR_PAD = 6

// ops that don't consume reference: INS, SOFT_CLIP, HARD_CLIP
const CIGAR_SKIP_MASK =
  (1 << CIGAR_INS) | (1 << CIGAR_SOFT_CLIP) | (1 << CIGAR_HARD_CLIP)
// const CIGAR_EQUAL = 7
// const CIGAR_DIFF = 8

interface Bytes {
  start: number
  end: number
  byteArray: Uint8Array
}

export default class BamRecord {
  public fileOffset: number
  private bytes: Bytes
  private _dataView: DataView

  constructor(args: { bytes: Bytes; fileOffset: number }) {
    this.bytes = args.bytes
    this.fileOffset = args.fileOffset
    this._dataView = new DataView(this.bytes.byteArray.buffer)
  }

  get byteArray() {
    return this.bytes.byteArray
  }

  get flags() {
    return (
      (this._dataView.getInt32(this.bytes.start + 16, true) & 0xffff0000) >> 16
    )
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

  get id() {
    return this.fileOffset
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
      return
    }

    const p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_bytes +
      this.num_seq_bytes
    return this.byteArray.subarray(p, p + this.seq_length)
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
    let p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_bytes +
      this.num_seq_bytes +
      this.seq_length

    const blockEnd = this.bytes.end
    while (p < blockEnd) {
      const tag =
        String.fromCharCode(this.byteArray[p]!) +
        String.fromCharCode(this.byteArray[p + 1]!)
      const type = String.fromCharCode(this.byteArray[p + 2]!)
      p += 3

      if (tag === 'MD' && type === 'Z') {
        const start = p
        while (p < blockEnd && this.byteArray[p] !== 0) {
          p++
        }
        return this.byteArray.subarray(start, p)
      }

      switch (type) {
        case 'A':
          p += 1
          break
        case 'i':
        case 'I':
        case 'f':
          p += 4
          break
        case 'c':
        case 'C':
          p += 1
          break
        case 's':
        case 'S':
          p += 2
          break
        case 'Z':
        case 'H':
          while (p <= blockEnd && this.byteArray[p++] !== 0) {}
          break
        case 'B': {
          const Btype = String.fromCharCode(this.byteArray[p++]!)
          const limit = this._dataView.getInt32(p, true)
          p += 4
          if (Btype === 'i' || Btype === 'I' || Btype === 'f') {
            p += limit << 2
          } else if (Btype === 's' || Btype === 'S') {
            p += limit << 1
          } else if (Btype === 'c' || Btype === 'C') {
            p += limit
          }
          break
        }
      }
    }
    return undefined
  }
  get tags() {
    let p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_bytes +
      this.num_seq_bytes +
      this.seq_length

    const blockEnd = this.bytes.end
    const tags = {} as Record<string, unknown>
    while (p < blockEnd) {
      const tag =
        String.fromCharCode(this.byteArray[p]!) +
        String.fromCharCode(this.byteArray[p + 1]!)
      const type = String.fromCharCode(this.byteArray[p + 2]!)
      p += 3

      switch (type) {
        case 'A':
          tags[tag] = String.fromCharCode(this.byteArray[p]!)
          p += 1
          break
        case 'i':
          tags[tag] = this._dataView.getInt32(p, true)
          p += 4
          break
        case 'I':
          tags[tag] = this._dataView.getUint32(p, true)
          p += 4
          break
        case 'c':
          tags[tag] = this._dataView.getInt8(p)
          p += 1
          break
        case 'C':
          tags[tag] = this._dataView.getUint8(p)
          p += 1
          break
        case 's':
          tags[tag] = this._dataView.getInt16(p, true)
          p += 2
          break
        case 'S':
          tags[tag] = this._dataView.getUint16(p, true)
          p += 2
          break
        case 'f':
          tags[tag] = this._dataView.getFloat32(p, true)
          p += 4
          break
        case 'Z':
        case 'H': {
          const value = []
          while (p <= blockEnd) {
            const cc = this.byteArray[p++]!
            if (cc !== 0) {
              value.push(String.fromCharCode(cc))
            } else {
              break
            }
          }
          tags[tag] = value.join('')
          break
        }
        case 'B': {
          const cc = this.byteArray[p++]!
          const Btype = String.fromCharCode(cc)
          const limit = this._dataView.getInt32(p, true)
          p += 4
          const absOffset = this.byteArray.byteOffset + p
          if (Btype === 'i') {
            if (absOffset % 4 === 0) {
              tags[tag] = new Int32Array(
                this.byteArray.buffer,
                absOffset,
                limit,
              )
            } else {
              const bytes = this.byteArray.slice(p, p + (limit << 2))
              tags[tag] = new Int32Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 2
          } else if (Btype === 'I') {
            if (absOffset % 4 === 0) {
              tags[tag] = new Uint32Array(
                this.byteArray.buffer,
                absOffset,
                limit,
              )
            } else {
              const bytes = this.byteArray.slice(p, p + (limit << 2))
              tags[tag] = new Uint32Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 2
          } else if (Btype === 's') {
            if (absOffset % 2 === 0) {
              tags[tag] = new Int16Array(
                this.byteArray.buffer,
                absOffset,
                limit,
              )
            } else {
              const bytes = this.byteArray.slice(p, p + (limit << 1))
              tags[tag] = new Int16Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 1
          } else if (Btype === 'S') {
            if (absOffset % 2 === 0) {
              tags[tag] = new Uint16Array(
                this.byteArray.buffer,
                absOffset,
                limit,
              )
            } else {
              const bytes = this.byteArray.slice(p, p + (limit << 1))
              tags[tag] = new Uint16Array(bytes.buffer, bytes.byteOffset, limit)
            }
            p += limit << 1
          } else if (Btype === 'c') {
            tags[tag] = new Int8Array(this.byteArray.buffer, absOffset, limit)
            p += limit
          } else if (Btype === 'C') {
            tags[tag] = new Uint8Array(this.byteArray.buffer, absOffset, limit)
            p += limit
          } else if (Btype === 'f') {
            if (absOffset % 4 === 0) {
              tags[tag] = new Float32Array(
                this.byteArray.buffer,
                absOffset,
                limit,
              )
            } else {
              const bytes = this.byteArray.slice(p, p + (limit << 2))
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

  /**
   * @returns {boolean} true if the read is paired, regardless of whether both
   * segments are mapped
   */
  isPaired() {
    return !!(this.flags & Constants.BAM_FPAIRED)
  }

  /** @returns {boolean} true if the read is paired, and both segments are mapped */
  isProperlyPaired() {
    return !!(this.flags & Constants.BAM_FPROPER_PAIR)
  }

  /** @returns {boolean} true if the read itself is unmapped; conflictive with isProperlyPaired */
  isSegmentUnmapped() {
    return !!(this.flags & Constants.BAM_FUNMAP)
  }

  /** @returns {boolean} true if the read itself is unmapped; conflictive with isProperlyPaired */
  isMateUnmapped() {
    return !!(this.flags & Constants.BAM_FMUNMAP)
  }

  /** @returns {boolean} true if the read is mapped to the reverse strand */
  isReverseComplemented() {
    return !!(this.flags & Constants.BAM_FREVERSE)
  }

  /** @returns {boolean} true if the mate is mapped to the reverse strand */
  isMateReverseComplemented() {
    return !!(this.flags & Constants.BAM_FMREVERSE)
  }

  /** @returns {boolean} true if this is read number 1 in a pair */
  isRead1() {
    return !!(this.flags & Constants.BAM_FREAD1)
  }

  /** @returns {boolean} true if this is read number 2 in a pair */
  isRead2() {
    return !!(this.flags & Constants.BAM_FREAD2)
  }

  /** @returns {boolean} true if this is a secondary alignment */
  isSecondary() {
    return !!(this.flags & Constants.BAM_FSECONDARY)
  }

  /** @returns {boolean} true if this read has failed QC checks */
  isFailedQc() {
    return !!(this.flags & Constants.BAM_FQCFAIL)
  }

  /** @returns {boolean} true if the read is an optical or PCR duplicate */
  isDuplicate() {
    return !!(this.flags & Constants.BAM_FDUP)
  }

  /** @returns {boolean} true if this is a supplementary alignment */
  isSupplementary() {
    return !!(this.flags & Constants.BAM_FSUPPLEMENTARY)
  }

  get cigarAndLength() {
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
    } else {
      const absOffset = this.byteArray.byteOffset + p
      const cigarView =
        absOffset % 4 === 0
          ? new Uint32Array(this.byteArray.buffer, absOffset, numCigarOps)
          : new Uint32Array(
              this.byteArray.slice(p, p + (numCigarOps << 2)).buffer,
              0,
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
    const seqBytes = this.byteArray.subarray(p, p + this.num_seq_bytes)
    return new Uint8Array(
      seqBytes.buffer,
      seqBytes.byteOffset,
      this.num_seq_bytes,
    )
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

function cacheGetter<T>(ctor: { prototype: T }, prop: keyof T): void {
  const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop)
  if (!desc) {
    throw new Error('OH NO, NO PROPERTY DESCRIPTOR')
  }
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const getter = desc.get
  if (!getter) {
    throw new Error('OH NO, NOT A GETTER')
  }
  Object.defineProperty(ctor.prototype, prop, {
    get() {
      const ret = getter.call(this)
      Object.defineProperty(this, prop, { value: ret })
      return ret
    },
  })
}

cacheGetter(BamRecord, 'tags')
cacheGetter(BamRecord, 'cigarAndLength')
cacheGetter(BamRecord, 'seq')
cacheGetter(BamRecord, 'qual')
cacheGetter(BamRecord, 'end')
