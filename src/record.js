const Constants = require('./constants')
const crc32 = require('buffer-crc32')

const _flagMasks = {
  multi_segment_template: 0x1,
  multi_segment_all_correctly_aligned: 0x2,
  unmapped: 0x4,
  multi_segment_next_segment_unmapped: 0x8,
  seq_reverse_complemented: 0x10,
  multi_segment_next_segment_reversed: 0x20,
  multi_segment_first: 0x40,
  multi_segment_last: 0x80,
  secondary_alignment: 0x100,
  qc_failed: 0x200,
  duplicate: 0x400,
  supplementary_alignment: 0x800,
}
const SEQRET_DECODER = [
  '=',
  'A',
  'C',
  'x',
  'G',
  'x',
  'x',
  'x',
  'T',
  'x',
  'x',
  'x',
  'x',
  'x',
  'x',
  'N',
]
const CIGAR_DECODER = [
  'M',
  'I',
  'D',
  'N',
  'S',
  'H',
  'P',
  '=',
  'X',
  '?',
  '?',
  '?',
  '?',
  '?',
  '?',
  '?',
]

/**
 * Class of each CRAM record returned by this API.
 */
class BamRecord {
  constructor(args) {
    this.data = {}
    this.bytes = {
      start: args.bytes.start,
      end: args.bytes.end,
      byteArray: args.bytes.byteArray,
    }

    this._coreParse()
  }

  /**
   * parse the core data: ref ID and start
   */
  _coreParse() {
    this._refID = this.bytes.byteArray.readInt32LE(this.bytes.start + 4)
    this.data.start = this.bytes.byteArray.readInt32LE(this.bytes.start + 8)
  }

  get(field) {
    return this._get(field.toLowerCase())
  }
  end() {
    return (
      this._get('start') +
      (this._get('length_on_ref') || this._get('seq_length') || undefined)
    )
  }
  // same as get(), except requires lower-case arguments.  used
  // internally to save lots of calls to field.toLowerCase()
  _get(field) {
    if(field in this.data) {
      return this.data[field]
    } else if(this[field]) {
      this.data[field] = this[field]()
      return this.data[field]
    } else if(this._flagMasks[field]) {
      this.data[field] = this._parseFlag(field)
      return this.data[field]
    } else {
      this.data[field] = this._parseTag(field)
      return this.data[field]
    }
  }

  tags() {
    return this._get('_tags')
  }

  _tags() {
    this._parseAllTags()

    let tags = [
      'seq',
      'seq_reverse_complemented',
      'unmapped',
      'qc_failed',
      'duplicate',
      'secondary_alignment',
      'supplementary_alignment',
    ]

    if (!this._get('unmapped'))
      tags.push(
        'start',
        'end',
        'strand',
        'score',
        'qual',
        'MQ',
        'CIGAR',
        'length_on_ref',
        'template_length',
      )
    if (this._get('multi_segment_template')) {
      tags.push(
        'multi_segment_all_correctly_aligned',
        'multi_segment_next_segment_unmapped',
        'multi_segment_next_segment_reversed',
        'multi_segment_first',
        'multi_segment_last',
        'next_segment_position',
      )
    }
    tags = tags.concat(this._tagList || [])

    const d = this.data
    for (const k in d) {
      if (
        d.hasOwnProperty(k) &&
        k[0] !== '_' &&
        k !== 'multi_segment_all_aligned' &&
        k !== 'next_seq_id'
      )
        tags.push(k)
    }

    const seen = {}
    tags = tags.filter(t => {
      if (t in this.data && this.data[t] === undefined) return false

      const lt = t.toLowerCase()
      const s = seen[lt]
      seen[lt] = true
      return !s
    })

    return tags
  }

  parent() {
    return undefined
  }

  children() {
    return this._get('subfeatures')
  }

  id() {
    return crc32.signed(
      this.bytes.byteArray.slice(this.bytes.start, this.bytes.end),
    )
  }

  multi_segment_all_aligned() {
    return this._get('multi_segment_all_correctly_aligned')
  }

  // special parsers
  /**
   * Mapping quality score.
   */
  mq() {
    const mq = (this._get('_bin_mq_nl') & 0xff00) >> 8
    return mq == 255 ? undefined : mq
  }
  score() {
    return this._get('mq')
  }
  qual() {
    if (this._get('unmapped')) return undefined

    const qseq = []
    const byteArray = this.bytes.byteArray
    const p =
      this.bytes.start +
      36 +
      this._get('_l_read_name') +
      this._get('_n_cigar_op') * 4 +
      this._get('_seq_bytes')
    const lseq = this._get('seq_length')
    for (let j = 0; j < lseq; ++j) {
      qseq.push(byteArray[p + j])
    }
    return qseq.join(' ')
  }
  strand() {
    return this._get('seq_reverse_complemented') ? -1 : 1
  }
  multi_segment_next_segment_strand() {
    if (this._get('multi_segment_next_segment_unmapped')) return undefined
    return this._get('multi_segment_next_segment_reversed') ? -1 : 1
  }
  /**
   * Get the value of a tag, parsing the tags as far as necessary.
   * Only called if we have not already parsed that field.
   */
  _parseTag(tagName) {
    // if all of the tags have been parsed and we're still being
    // called, we already know that we have no such tag, because
    // it would already have been cached.
    if (this._allTagsParsed) return undefined

    this._tagList = this._tagList || []
    const byteArray = this.bytes.byteArray
    let p =
      this._tagOffset ||
      this.bytes.start +
        36 +
        this._get('_l_read_name') +
        this._get('_n_cigar_op') * 4 +
        this._get('_seq_bytes') +
        this._get('seq_length')

    const blockEnd = this.bytes.end
    let lcTag
    while (p < blockEnd && lcTag !== tagName) {
      const tag = String.fromCharCode(byteArray[p], byteArray[p + 1])
      lcTag = tag.toLowerCase()
      const type = String.fromCharCode(byteArray[p + 2])
      p += 3

      var value
      switch (type.toLowerCase()) {
        case 'a':
          value = String.fromCharCode(byteArray[p])
          p += 1
          break
        case 'i':
          value = byteArray.readInt32LE(p)
          p += 4
          break
        case 'c':
          value = byteArray.readInt8(p)
          p += 1
          break
        case 's':
          value = byteArray.readInt16LE(p)
          p += 2
          break
        case 'f':
          value = byteArray.readFloatLE(p)
          p += 4
          break
        case 'z':
        case 'h':
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
        case 'b':
          value = ''
          const cc = byteArray[p++]
          var Btype = String.fromCharCode(cc)
          if (Btype === 'i' || Btype === 'I') {
            const limit = byteArray.readInt32LE(p)
            p += 4
            for (let k = 0; k < limit; k++) {
              value += byteArray.readInt32LE(p)
              if (k + 1 < limit) value += ','
              p += 4
            }
          }
          if (Btype === 's' || Btype === 'S') {
            const limit = byteArray.readInt32LE(p)
            p += 4
            for (let k = 0; k < limit; k++) {
              value += byteArray.readInt16LE(p)
              if (k + 1 < limit) value += ','
              p += 2
            }
          }
          if (Btype === 'c' || Btype === 'C') {
            const limit = byteArray.readInt32LE(p)
            p += 4
            for (let k = 0; k < limit; k++) {
              value += byteArray.readInt8(p)
              if (k + 1 < limit) value += ','
              p += 1
            }
          }
          if (Btype === 'f') {
            const limit = byteArray.readInt32LE(p)
            p += 4
            for (let k = 0; k < limit; k++) {
              value += byteArray.readFloatLE(p)
              if (k + 1 < limit) value += ','
              p += 4
            }
          }
          break
        default:
          console.warn(`Unknown BAM tag type '${type}', tags may be incomplete`)
          value = undefined
          p = blockEnd // stop parsing tags
      }

      this._tagOffset = p

      this._tagList.push(tag)
      if (lcTag === tagName) return value

      this.data[lcTag] = value
    }
    this._allTagsParsed = true
    return undefined
  }
  _parseAllTags() {
    this._parseTag()
  }

  _parseFlag(flagName) {
    return !!(this._get('_flags') & _flagMasks[flagName])
  }
  /**
   * @returns {boolean} true if the read is paired, regardless of whether both segments are mapped
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

  /**
   * @returns {boolean} true if the read is detached
   */
  isDetached() {
    return !!(this.cramFlags & Constants.CRAM_FLAG_DETACHED)
  }

  /** @returns {boolean} true if the read has a mate in this same CRAM segment */
  hasMateDownStream() {
    return !!(this.cramFlags & Constants.CRAM_FLAG_MATE_DOWNSTREAM)
  }

  /** @returns {boolean} true if the read contains qual scores */
  isPreservingQualityScores() {
    return !!(this.cramFlags & Constants.CRAM_FLAG_PRESERVE_QUAL_SCORES)
  }

  /** @returns {boolean} true if the read has no sequence bases */
  isUnknownBases() {
    return !!(this.cramFlags & Constants.CRAM_FLAG_NO_SEQ)
  }
  cigar() {
    if (this.isSegmentUnmapped()) return undefined

    const byteArray = this.bytes.byteArray
    const numCigarOps = this._get('_n_cigar_op')
    let p = this.bytes.start + 36 + this._get('_l_read_name')
    let cigar = ''
    let lref = 0
    for (let c = 0; c < numCigarOps; ++c) {
      const cigop = byteArray.readInt32LE(p)
      const lop = cigop >> 4
      const op = CIGAR_DECODER[cigop & 0xf]
      cigar += lop + op

      // soft clip, hard clip, and insertion don't count toward
      // the length on the reference
      if (op !== 'H' && op !== 'S' && op !== 'I') lref += lop

      p += 4
    }

    this.data.length_on_ref = lref
    return cigar
  }
  length_on_ref() {
    const c = this._get('cigar') // the length_on_ref is set as a
    // side effect of the CIGAR parsing
    return this.data.length_on_ref
  }
  _flag_nc() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 16)
  }
  _n_cigar_op() {
    return this._get('_flag_nc') & 0xffff
  }
  _l_read_name() {
    return this._get('_bin_mq_nl') & 0xff
  }
  /**
   * number of bytes in the sequence field
   */
  _seq_bytes() {
    return (this._get('seq_length') + 1) >> 1
  }
  seq() {
    let seq = ''
    const byteArray = this.bytes.byteArray
    const p =
      this.bytes.start +
      36 +
      this._get('_l_read_name') +
      this._get('_n_cigar_op') * 4
    const seqBytes = this._get('_seq_bytes')
    for (let j = 0; j < seqBytes; ++j) {
      const sb = byteArray[p + j]
      seq += SEQRET_DECODER[(sb & 0xf0) >> 4]
      if (seq.length < this.get('seq_length')) seq += SEQRET_DECODER[sb & 0x0f]
    }
    return seq
  }

  _bin_mq_nl() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 12)
  }
  seq_length() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 20)
  }
  _next_refid() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 24)
  }
  _next_pos() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 28)
  }
  template_length() {
    return this.bytes.byteArray.readInt32LE(this.bytes.start + 32)
  }
  /**
   * Get the original sequence of this read.
   * @returns {String} sequence basepairs
   */
  getReadBases() {
    return this.readBases
  }

  toJSON() {
    const data = {}
    Object.keys(this).forEach(k => {
      if (k.charAt(0) === '_') return
      data[k] = this[k]
    })

    return data
  }
}

module.exports = BamRecord
