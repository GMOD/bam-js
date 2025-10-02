import Constants from './constants.ts'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const CIGAR_DECODER = 'MIDNSHP=X???????'.split('')

interface Bytes {
  start: number
  end: number
  byteArray: Uint8Array
}

export default class BamRecord {
  public fileOffset: number
  private bytes: Bytes
  #dataView: DataView

  constructor(args: { bytes: Bytes; fileOffset: number }) {
    this.bytes = args.bytes
    this.fileOffset = args.fileOffset
    this.#dataView = new DataView(this.bytes.byteArray.buffer)
  }

  get byteArray() {
    return this.bytes.byteArray
  }

  get flags() {
    return (
      (this.#dataView.getInt32(this.bytes.start + 16, true) & 0xffff0000) >> 16
    )
  }
  get ref_id() {
    return this.#dataView.getInt32(this.bytes.start + 4, true)
  }

  get start() {
    return this.#dataView.getInt32(this.bytes.start + 8, true)
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

  get tags() {
    let p =
      this.b0 +
      this.read_name_length +
      this.num_cigar_ops * 4 +
      this.num_seq_bytes +
      this.seq_length

    const blockEnd = this.bytes.end
    const tags = {} as Record<string, unknown>
    while (p < blockEnd) {
      const tag = String.fromCharCode(
        this.byteArray[p]!,
        this.byteArray[p + 1]!,
      )
      const type = String.fromCharCode(this.byteArray[p + 2]!)
      p += 3

      if (type === 'A') {
        tags[tag] = String.fromCharCode(this.byteArray[p]!)
        p += 1
      } else if (type === 'i') {
        tags[tag] = this.#dataView.getInt32(p, true)
        p += 4
      } else if (type === 'I') {
        tags[tag] = this.#dataView.getUint32(p, true)
        p += 4
      } else if (type === 'c') {
        tags[tag] = this.#dataView.getInt8(p)
        p += 1
      } else if (type === 'C') {
        tags[tag] = this.#dataView.getUint8(p)
        p += 1
      } else if (type === 's') {
        tags[tag] = this.#dataView.getInt16(p, true)
        p += 2
      } else if (type === 'S') {
        tags[tag] = this.#dataView.getUint16(p, true)
        p += 2
      } else if (type === 'f') {
        tags[tag] = this.#dataView.getFloat32(p, true)
        p += 4
      } else if (type === 'Z' || type === 'H') {
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
      } else if (type === 'B') {
        const cc = this.byteArray[p++]!
        const Btype = String.fromCharCode(cc)
        const limit = this.#dataView.getInt32(p, true)
        p += 4
        if (Btype === 'i') {
          if (tag === 'CG') {
            const value = []
            for (let k = 0; k < limit; k++) {
              const cigop = this.#dataView.getInt32(p, true)
              const lop = cigop >> 4
              const op = CIGAR_DECODER[cigop & 0xf]!
              value.push(lop + op)
              p += 4
            }
            tags[tag] = value.join('')
          } else {
            const value = []
            for (let k = 0; k < limit; k++) {
              value.push(this.#dataView.getInt32(p, true))
              p += 4
            }
            tags[tag] = value
          }
        } else if (Btype === 'I') {
          if (tag === 'CG') {
            const value = []
            for (let k = 0; k < limit; k++) {
              const cigop = this.#dataView.getUint32(p, true)
              const lop = cigop >> 4
              const op = CIGAR_DECODER[cigop & 0xf]!
              value.push(lop + op)
              p += 4
            }
            tags[tag] = value.join('')
          } else {
            const value = []
            for (let k = 0; k < limit; k++) {
              value.push(this.#dataView.getUint32(p, true))
              p += 4
            }
            tags[tag] = value
          }
        } else if (Btype === 's') {
          const value = []
          for (let k = 0; k < limit; k++) {
            value.push(this.#dataView.getInt16(p, true))
            p += 2
          }
          tags[tag] = value
        } else if (Btype === 'S') {
          const value = []
          for (let k = 0; k < limit; k++) {
            value.push(this.#dataView.getUint16(p, true))
            p += 2
          }
          tags[tag] = value
        } else if (Btype === 'c') {
          const value = []
          for (let k = 0; k < limit; k++) {
            value.push(this.#dataView.getInt8(p))
            p += 1
          }
          tags[tag] = value
        } else if (Btype === 'C') {
          const value = []
          for (let k = 0; k < limit; k++) {
            value.push(this.#dataView.getUint8(p))
            p += 1
          }
          tags[tag] = value
        } else if (Btype === 'f') {
          const value = []
          for (let k = 0; k < limit; k++) {
            value.push(this.#dataView.getFloat32(p, true))
            p += 4
          }
          tags[tag] = value
        }
      } else {
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
        CIGAR: '',
      }
    }

    const numCigarOps = this.num_cigar_ops
    let p = this.b0 + this.read_name_length
    const CIGAR = []

    // check for CG tag by inspecting whether the CIGAR field contains a clip
    // that consumes entire seqLen
    let cigop = this.#dataView.getInt32(p, true)
    let lop = cigop >> 4
    let op = CIGAR_DECODER[cigop & 0xf]
    if (op === 'S' && lop === this.seq_length) {
      // if there is a CG the second CIGAR field will be a N tag the represents
      // the length on ref
      p += 4
      cigop = this.#dataView.getInt32(p, true)
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
        cigop = this.#dataView.getInt32(p, true)
        lop = cigop >> 4
        op = CIGAR_DECODER[cigop & 0xf]!
        CIGAR.push(lop + op)
        // soft clip, hard clip, and insertion don't count toward the length on
        // the reference
        if (op !== 'H' && op !== 'S' && op !== 'I') {
          lref += lop
        }

        p += 4
      }

      return {
        CIGAR: CIGAR.join(''),
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
    const len = this.seq_length
    let buf = ''
    let i = 0
    for (let j = 0; j < this.num_seq_bytes; ++j) {
      const sb =
        this.byteArray[
          this.b0 + this.read_name_length + this.num_cigar_ops * 4 + j
        ]!
      buf += SEQRET_DECODER[(sb & 0xf0) >> 4]
      i++
      if (i < len) {
        buf += SEQRET_DECODER[sb & 0x0f]
        i++
      }
    }
    return buf
  }

  /**
   * Get the nucleotide at a specific position in the sequence without decoding the entire sequence
   * @param idx The 0-based index of the nucleotide to retrieve
   * @returns The nucleotide character at the specified position, or undefined if index is out of bounds
   */
  seqAt(idx: number): string | undefined {
    // Each byte contains 2 nucleotides (4 bits each)
    // Calculate which byte contains our target nucleotide
    const byteIndex = idx >> 1
    const sb =
      this.byteArray[
        this.b0 + this.read_name_length + this.num_cigar_ops * 4 + byteIndex
      ]!

    // Determine if we want the upper or lower 4 bits
    return idx % 2 === 0
      ? SEQRET_DECODER[(sb & 0xf0) >> 4] // Even index: upper 4 bits
      : SEQRET_DECODER[sb & 0x0f] // Odd index: lower 4 bits
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
    return this.#dataView.getInt32(this.bytes.start + 12, true)
  }

  get flag_nc() {
    return this.#dataView.getInt32(this.bytes.start + 16, true)
  }

  get seq_length() {
    return this.#dataView.getInt32(this.bytes.start + 20, true)
  }

  get next_refid() {
    return this.#dataView.getInt32(this.bytes.start + 24, true)
  }

  get next_pos() {
    return this.#dataView.getInt32(this.bytes.start + 28, true)
  }

  get template_length() {
    return this.#dataView.getInt32(this.bytes.start + 32, true)
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
