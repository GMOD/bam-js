import Constants from './constants'
import type { Buffer } from 'buffer'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const CIGAR_DECODER = 'MIDNSHP=X???????'.split('')

interface Bytes {
  start: number
  end: number
  byteArray: Buffer
}
export default class BamRecord {
  public fileOffset: number
  private bytes: Bytes

  constructor(args: { bytes: Bytes; fileOffset: number }) {
    this.bytes = args.bytes
    this.fileOffset = args.fileOffset
  }

  get byteArray() {
    return this.bytes.byteArray
  }

  get flags() {
    return (
      (this.byteArray.readInt32LE(this.bytes.start + 16) & 0xffff0000) >> 16
    )
  }
  get ref_id() {
    return this.byteArray.readInt32LE(this.bytes.start + 4)
  }

  get start() {
    return this.byteArray.readInt32LE(this.bytes.start + 8)
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
    return this.qualRaw?.join(' ')
  }

  get qualRaw() {
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
    return this.byteArray.toString(
      'ascii',
      this.b0,
      this.b0 + this.read_name_length - 1,
    )
  }

  get tags() {
    const { byteArray } = this.bytes
    let p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_ops * 4 +
      this.num_seq_bytes +
      this.seq_length

    const blockEnd = this.bytes.end
    const tags = {} as Record<string, unknown>
    while (p < blockEnd) {
      const tag = String.fromCharCode(byteArray[p], byteArray[p + 1])
      const type = String.fromCharCode(byteArray[p + 2])
      p += 3

      let value
      switch (type) {
        case 'A': {
          value = String.fromCharCode(byteArray[p])
          p += 1
          break
        }
        case 'i': {
          value = byteArray.readInt32LE(p)
          p += 4
          break
        }
        case 'I': {
          value = byteArray.readUInt32LE(p)
          p += 4
          break
        }
        case 'c': {
          value = byteArray.readInt8(p)
          p += 1
          break
        }
        case 'C': {
          value = byteArray.readUInt8(p)
          p += 1
          break
        }
        case 's': {
          value = byteArray.readInt16LE(p)
          p += 2
          break
        }
        case 'S': {
          value = byteArray.readUInt16LE(p)
          p += 2
          break
        }
        case 'f': {
          value = byteArray.readFloatLE(p)
          p += 4
          break
        }
        case 'Z':
        case 'H': {
          value = ''
          while (p <= blockEnd) {
            const cc = byteArray[p++]
            if (cc === 0) {
              break
            } else {
              value += String.fromCharCode(cc)
            }
          }
          break
        }
        case 'B': {
          value = ''
          const cc = byteArray[p++]
          const Btype = String.fromCharCode(cc)
          const limit = byteArray.readInt32LE(p)
          p += 4
          if (Btype === 'i') {
            if (tag === 'CG') {
              for (let k = 0; k < limit; k++) {
                const cigop = byteArray.readInt32LE(p)
                const lop = cigop >> 4
                const op = CIGAR_DECODER[cigop & 0xf]
                value += lop + op
                p += 4
              }
            } else {
              for (let k = 0; k < limit; k++) {
                value += byteArray.readInt32LE(p)
                if (k + 1 < limit) {
                  value += ','
                }
                p += 4
              }
            }
          }
          if (Btype === 'I') {
            if (tag === 'CG') {
              for (let k = 0; k < limit; k++) {
                const cigop = byteArray.readUInt32LE(p)
                const lop = cigop >> 4
                const op = CIGAR_DECODER[cigop & 0xf]
                value += lop + op
                p += 4
              }
            } else {
              for (let k = 0; k < limit; k++) {
                value += byteArray.readUInt32LE(p)
                if (k + 1 < limit) {
                  value += ','
                }
                p += 4
              }
            }
          }
          if (Btype === 's') {
            for (let k = 0; k < limit; k++) {
              value += byteArray.readInt16LE(p)
              if (k + 1 < limit) {
                value += ','
              }
              p += 2
            }
          }
          if (Btype === 'S') {
            for (let k = 0; k < limit; k++) {
              value += byteArray.readUInt16LE(p)
              if (k + 1 < limit) {
                value += ','
              }
              p += 2
            }
          }
          if (Btype === 'c') {
            for (let k = 0; k < limit; k++) {
              value += byteArray.readInt8(p)
              if (k + 1 < limit) {
                value += ','
              }
              p += 1
            }
          }
          if (Btype === 'C') {
            for (let k = 0; k < limit; k++) {
              value += byteArray.readUInt8(p)
              if (k + 1 < limit) {
                value += ','
              }
              p += 1
            }
          }
          if (Btype === 'f') {
            for (let k = 0; k < limit; k++) {
              value += byteArray.readFloatLE(p)
              if (k + 1 < limit) {
                value += ','
              }
              p += 4
            }
          }
          break
        }
        default: {
          console.warn(`Unknown BAM tag type '${type}', tags may be incomplete`)
          value = undefined
          p = blockEnd
        } // stop parsing tags
      }

      tags[tag] = value
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
        CIGAR: '',
      }
    }

    const numCigarOps = this.num_cigar_ops
    let p = this.b0 + this.read_name_length
    let CIGAR = ''

    // check for CG tag by inspecting whether the CIGAR field contains a clip
    // that consumes entire seqLen
    let cigop = this.byteArray.readInt32LE(p)
    let lop = cigop >> 4
    let op = CIGAR_DECODER[cigop & 0xf]
    if (op === 'S' && lop === this.seq_length) {
      // if there is a CG the second CIGAR field will be a N tag the represents
      // the length on ref
      p += 4
      cigop = this.byteArray.readInt32LE(p)
      lop = cigop >> 4
      op = CIGAR_DECODER[cigop & 0xf]
      if (op !== 'N') {
        console.warn('CG tag with no N tag')
      }
      return {
        CIGAR: this.tags.CG as string,
        length_on_ref: lop,
      }
    } else {
      let lref = 0
      for (let c = 0; c < numCigarOps; ++c) {
        cigop = this.byteArray.readInt32LE(p)
        lop = cigop >> 4
        op = CIGAR_DECODER[cigop & 0xf]
        CIGAR += lop + op
        // soft clip, hard clip, and insertion don't count toward
        // the length on the reference
        if (op !== 'H' && op !== 'S' && op !== 'I') {
          lref += lop
        }

        p += 4
      }

      return {
        CIGAR,
        length_on_ref: lref,
      }
    }
  }

  get length_on_ref() {
    return this.cigarAndLength.length_on_ref
  }

  get CIGAR() {
    return this.cigarAndLength.CIGAR
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

  get seq() {
    const { byteArray } = this.bytes
    const p = this.b0 + this.read_name_length + this.num_cigar_ops * 4
    const seqBytes = this.num_seq_bytes
    const len = this.seq_length
    let buf = ''
    let i = 0
    for (let j = 0; j < seqBytes; ++j) {
      const sb = byteArray[p + j]
      buf += SEQRET_DECODER[(sb & 0xf0) >> 4]
      i++
      if (i < len) {
        buf += SEQRET_DECODER[sb & 0x0f]
        i++
      }
    }
    return buf
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
    return ''
  }

  get bin_mq_nl() {
    return this.byteArray.readInt32LE(this.bytes.start + 12)
  }

  get flag_nc() {
    return this.byteArray.readInt32LE(this.bytes.start + 16)
  }

  get seq_length() {
    return this.byteArray.readInt32LE(this.bytes.start + 20)
  }

  get next_refid() {
    return this.byteArray.readInt32LE(this.bytes.start + 24)
  }

  get next_pos() {
    return this.byteArray.readInt32LE(this.bytes.start + 28)
  }

  get template_length() {
    return this.byteArray.readInt32LE(this.bytes.start + 32)
  }

  toJSON() {
    const data: Record<string, any> = {}
    for (const k of Object.keys(this)) {
      if (k.startsWith('_') || k === 'bytes') {
        continue
      }
      //@ts-ignore
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
