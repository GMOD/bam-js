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
  private _tagCache: Record<string, unknown> | undefined

  constructor(args: { bytes: Bytes; fileOffset: number }) {
    this.bytes = args.bytes
    this.fileOffset = args.fileOffset
    this._dataView = new DataView(this.bytes.byteArray.buffer)
  }

  private _tagStart() {
    return (
      this.b0 +
      this.read_name_length +
      this.num_cigar_ops * 4 +
      this.num_seq_bytes +
      this.seq_length
    )
  }

  private _skipTagValue(p: number, typeCode: number) {
    const ba = this.byteArray
    const blockEnd = this.bytes.end
    // A=65, c=99, C=67, s=115, S=83, i=105, I=73, f=102, Z=90, H=72, B=66
    if (typeCode === 65 || typeCode === 99 || typeCode === 67) {
      return p + 1
    }
    if (typeCode === 115 || typeCode === 83) {
      return p + 2
    }
    if (typeCode === 105 || typeCode === 73 || typeCode === 102) {
      return p + 4
    }
    if (typeCode === 90 || typeCode === 72) {
      while (p < blockEnd && ba[p] !== 0) {
        p++
      }
      return p + 1
    }
    if (typeCode === 66) {
      const Btype = ba[p]!
      const count = this._dataView.getInt32(p + 1, true)
      p += 5
      // c=99, C=67, s=115, S=83, i=105, I=73, f=102
      if (Btype === 99 || Btype === 67) {
        return p + count
      }
      if (Btype === 115 || Btype === 83) {
        return p + count * 2
      }
      return p + count * 4
    }
    return p
  }

  private _parseTagValue(p: number, typeCode: number) {
    const ba = this.byteArray
    const dv = this._dataView
    // A=65, c=99, C=67, s=115, S=83, i=105, I=73, f=102, Z=90, H=72, B=66
    if (typeCode === 65) {
      return String.fromCharCode(ba[p]!)
    }
    if (typeCode === 105) {
      return dv.getInt32(p, true)
    }
    if (typeCode === 73) {
      return dv.getUint32(p, true)
    }
    if (typeCode === 99) {
      return dv.getInt8(p)
    }
    if (typeCode === 67) {
      return dv.getUint8(p)
    }
    if (typeCode === 115) {
      return dv.getInt16(p, true)
    }
    if (typeCode === 83) {
      return dv.getUint16(p, true)
    }
    if (typeCode === 102) {
      return dv.getFloat32(p, true)
    }
    if (typeCode === 90 || typeCode === 72) {
      let str = ''
      while (ba[p] !== 0) {
        str += String.fromCharCode(ba[p]!)
        p++
      }
      return str
    }
    if (typeCode === 66) {
      const Btype = ba[p]!
      const count = dv.getInt32(p + 1, true)
      p += 5
      const result: number[] = new Array(count)
      // c=99, C=67, s=115, S=83, i=105, I=73, f=102
      if (Btype === 99) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getInt8(p)
          p++
        }
      } else if (Btype === 67) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getUint8(p)
          p++
        }
      } else if (Btype === 115) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getInt16(p, true)
          p += 2
        }
      } else if (Btype === 83) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getUint16(p, true)
          p += 2
        }
      } else if (Btype === 105) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getInt32(p, true)
          p += 4
        }
      } else if (Btype === 73) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getUint32(p, true)
          p += 4
        }
      } else if (Btype === 102) {
        for (let i = 0; i < count; i++) {
          result[i] = dv.getFloat32(p, true)
          p += 4
        }
      }
      return result
    }
    return undefined
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
      this.num_cigar_ops * 4 +
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

  getTag(name: string) {
    if (this._tagCache) {
      const cached = this._tagCache[name]
      if (cached !== undefined) {
        return cached
      }
    } else {
      this._tagCache = {}
    }
    const ba = this.byteArray
    const blockEnd = this.bytes.end
    const c0 = name.charCodeAt(0)
    const c1 = name.charCodeAt(1)
    let p = this._tagStart()
    while (p < blockEnd) {
      const t0 = ba[p]!
      const t1 = ba[p + 1]!
      const typeCode = ba[p + 2]!
      p += 3
      if (t0 === c0 && t1 === c1) {
        const value = this._parseTagValue(p, typeCode)
        this._tagCache[name] = value
        return value
      }
      p = this._skipTagValue(p, typeCode)
    }
    return undefined
  }

  getAllTags() {
    const ba = this.byteArray
    const blockEnd = this.bytes.end
    const result = {} as Record<string, unknown>
    let p = this._tagStart()
    while (p < blockEnd) {
      const tag =
        String.fromCharCode(ba[p]!) + String.fromCharCode(ba[p + 1]!)
      const typeCode = ba[p + 2]!
      p += 3
      result[tag] = this._parseTagValue(p, typeCode)
      p = this._skipTagValue(p, typeCode)
    }
    return result
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
      const cgArray = this.getTag('CG') as number[]
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
              this.byteArray.slice(p, p + numCigarOps * 4).buffer,
              0,
              numCigarOps,
            )
      let lref = 0
      for (let c = 0; c < numCigarOps; ++c) {
        const cigop = cigarView[c]!
        const op = cigop & 0xf
        // soft clip, hard clip, and insertion don't count toward the length on
        // the reference
        if (
          op !== CIGAR_HARD_CLIP &&
          op !== CIGAR_SOFT_CLIP &&
          op !== CIGAR_INS
        ) {
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

  get read_name_length() {
    return this.bin_mq_nl & 0xff
  }

  get num_seq_bytes() {
    return (this.seq_length + 1) >> 1
  }

  get NUMERIC_SEQ() {
    const p = this.b0 + this.read_name_length + this.num_cigar_ops * 4
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
          this.b0 + this.read_name_length + this.num_cigar_ops * 4 + byteIndex
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

cacheGetter(BamRecord, 'cigarAndLength')
cacheGetter(BamRecord, 'seq')
cacheGetter(BamRecord, 'qual')
cacheGetter(BamRecord, 'end')
