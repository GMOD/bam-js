import { CIGAR_REF_SKIP, CIGAR_SOFT_CLIP } from './cigar.ts'
import Constants from './constants.ts'

const SEQRET = '=ACMGRSVTWYHKDBN'
const SEQRET_DECODER = SEQRET.split('')
const SEQRET_CODES = Uint8Array.from(SEQRET, c => c.charCodeAt(0))

// Both bases of a SEQ byte, precomputed for all 256 bytes so decoding advances a
// byte at a time. Two forms because `seq` has two strategies (see below): packed
// ASCII codes for a single Uint16Array store, and the 2-char string to append.
// Byte order within the u16 depends on host endianness.
const LITTLE_ENDIAN = new Uint16Array(Uint8Array.of(1, 0).buffer)[0] === 1
const SEQRET_PAIR_CODES = new Uint16Array(256)
const SEQRET_PAIR_STRINGS = new Array<string>(256)
for (let hi = 0; hi < 16; hi++) {
  for (let lo = 0; lo < 16; lo++) {
    const h = SEQRET_CODES[hi]!
    const l = SEQRET_CODES[lo]!
    SEQRET_PAIR_CODES[(hi << 4) | lo] = LITTLE_ENDIAN
      ? h | (l << 8)
      : (h << 8) | l
    SEQRET_PAIR_STRINGS[(hi << 4) | lo] =
      SEQRET_DECODER[hi]! + SEQRET_DECODER[lo]!
  }
}

// Read length at which building a byte buffer and calling TextDecoder once
// overtakes plain string concatenation. Below it concat wins by 2-4x (rope
// building is cheap and the decode has fixed overhead); above it the decoder
// wins by 5-8x. Measured crossover is ~300bp, i.e. just past typical Illumina
// read lengths.
const SEQ_DECODER_THRESHOLD = 300

// Four bases per entry, indexed by a PAIR of SEQ bytes, so the sub-threshold
// path halves its concat count: 1.5-1.6x on a short-read query end to end
// (shortreads_300x 46.5 -> 30.5 ms over 53.6k reads, volvox 4.8 -> 2.9 ms).
//
// Built lazily, and only once the short path has been taken enough times to pay
// for it. Filling 65536 entries costs ~6 ms and retains ~2 MB, so building on
// first use is a LOSS on a file that decodes only a handful of short reads:
// long-read fixtures with a short-read tail measured 1.4x slower that way
// (ecoli_nanopore has 27 sub-300bp reads out of 480, chm1 has 5 of 204). The
// counter is module-global on purpose — the table is shared, so what has to
// amortize is the total number of short decodes in the process, not per file.
const SEQRET_QUAD_WARMUP = 1024
let seqretShortCalls = 0
let SEQRET_QUAD_STRINGS: string[] | undefined

// The 4-base table, or undefined while still warming up (caller falls back to
// the 2-base table).
function seqretQuads() {
  if (SEQRET_QUAD_STRINGS === undefined) {
    if (++seqretShortCalls < SEQRET_QUAD_WARMUP) {
      return undefined
    }
    const quads = new Array<string>(65536)
    for (let a = 0; a < 256; a++) {
      const sa = SEQRET_PAIR_STRINGS[a]!
      const base = a << 8
      for (let b = 0; b < 256; b++) {
        quads[base | b] = sa + SEQRET_PAIR_STRINGS[b]!
      }
    }
    SEQRET_QUAD_STRINGS = quads
  }
  return SEQRET_QUAD_STRINGS
}

// Precomputed pair orientation strings, indexed by
//   ((flags >> 4) & 0x7) | (selfIsLeft ? 8 : 0)
// bits 0-2 are flag bits 0x10 (self reverse), 0x20 (mate reverse), 0x40 (read1);
// bit 3 is whether this read is the leftmost of the pair. The read2 flag (0x80)
// is deliberately not consulted — "not read1" is what decides the numbering, so
// a record with neither flag set reads the same as read2.
// prettier-ignore
const PAIR_ORIENTATION_TABLE = [
  'F1F2','F1R2','R1F2','R1R2','F2F1','F2R1','R2F1','R2R1',
  'F2F1','R2F1','F2R1','R2R1','F1F2','R1F2','F1R2','R1R2',
]
const ASCII_CIGAR_CODES = [
  77, 73, 68, 78, 83, 72, 80, 61, 88, 63, 63, 63, 63, 63, 63, 63,
]

const textDecoder = new TextDecoder()

// Interned two-char tag names keyed on the packed byte pair. Worth more than
// the saved String.fromCharCode: the tags object is null-prototype and so in
// dictionary mode, and handing it a string V8 has already hashed halves the
// per-tag insert cost.
const TAG_NAMES = new Map<number, string>()
function tagName(b0: number, b1: number) {
  const key = (b0 << 8) | b1
  let name = TAG_NAMES.get(key)
  if (name === undefined) {
    name = String.fromCharCode(b0, b1)
    TAG_NAMES.set(key, name)
  }
  return name
}

// TextDecoder carries ~0.35us of fixed setup per call, which dominates for the
// short values Z/H tags usually hold (MD, RG, PG, ...): char codes are 4x
// faster at 8 bytes, 2x at 16, and the two cross over at 32.
const SHORT_STRING_THRESHOLD = 32

// Z/H tag values are spec'd as printable ASCII, but a non-conforming writer
// would make the char-code path mis-decode UTF-8, so bail to TextDecoder on any
// high byte.
function decodeTagString(ba: Uint8Array, start: number, end: number) {
  const len = end - start
  if (len < SHORT_STRING_THRESHOLD) {
    const codes = new Array<number>(len)
    for (let i = 0; i < len; i++) {
      const byte = ba[start + i]!
      if (byte > 0x7f) {
        return textDecoder.decode(ba.subarray(start, end))
      }
      codes[i] = byte
    }
    return String.fromCharCode(...codes)
  }
  return textDecoder.decode(ba.subarray(start, end))
}

// Bitmask for ops that consume ref: M=0, D=2, N=3, ==7, X=8
// Binary: 0b110001101 = 0x18D
//
// P (=6) is NOT among them. Padding is a silent placeholder against a padded
// reference and advances neither query nor reference, which is what htslib's
// bam_cigar_type(P) == 0 says. Including it made every read carrying a P op
// report an end one base per padded base too far.
//
// That said: nobody cares about P. Padded alignments come out of a handful of
// assembly tools and are effectively absent from real BAMs — this was fixed
// because it disagreed with htslib, not because it was hurting anyone. It is
// covered incidentally by samspec.bam in the samtools agreement suite, and
// that is enough; don't spend a dedicated fixture or test on it.
const CIGAR_CONSUMES_REF_MASK = 0x18d

// A CIGAR as packed op words. Either a view over (or copy of) the record's own
// CIGAR field, or the CG tag's array for long-CIGAR records — hence Int32Array
// too, since a writer may encode CG as B:i rather than the usual B:I.
export type NumericCigar = Uint32Array | Int32Array | number[]

function isNumericCigar(value: unknown): value is NumericCigar {
  return (
    value instanceof Uint32Array ||
    value instanceof Int32Array ||
    Array.isArray(value)
  )
}

type BArrayValue =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | number[]

// Decode a 'B' (array) tag value starting at `p` (the byte after type+subtype+
// count). When the data is naturally aligned we return a typed-array view over
// the underlying buffer (zero-copy); otherwise we copy element-by-element since
// typed-array views require alignment. The copy target is a plain array, not a
// typed one: benchmarking the unaligned path found number[] fills faster below
// ~10k elements and reads at least as fast at every size, so the only thing a
// typed copy would buy is half the retained bytes. Shared by getTag and the
// full-tag parse.
function decodeBArrayTag(
  ba: Uint8Array,
  dataView: DataView,
  p: number,
  Btype: number,
  limit: number,
): BArrayValue | undefined {
  const absOffset = ba.byteOffset + p
  switch (Btype) {
    case 0x69: {
      // 'i'
      if (absOffset % 4 === 0) {
        return new Int32Array(ba.buffer, absOffset, limit)
      }
      const arr = new Array<number>(limit)
      for (let i = 0; i < limit; i++) {
        arr[i] = dataView.getInt32(p + i * 4, true)
      }
      return arr
    }
    case 0x49: {
      // 'I'
      if (absOffset % 4 === 0) {
        return new Uint32Array(ba.buffer, absOffset, limit)
      }
      const arr = new Array<number>(limit)
      for (let i = 0; i < limit; i++) {
        arr[i] = dataView.getUint32(p + i * 4, true)
      }
      return arr
    }
    case 0x73: {
      // 's'
      if (absOffset % 2 === 0) {
        return new Int16Array(ba.buffer, absOffset, limit)
      }
      const arr = new Array<number>(limit)
      for (let i = 0; i < limit; i++) {
        arr[i] = dataView.getInt16(p + i * 2, true)
      }
      return arr
    }
    case 0x53: {
      // 'S'
      if (absOffset % 2 === 0) {
        return new Uint16Array(ba.buffer, absOffset, limit)
      }
      const arr = new Array<number>(limit)
      for (let i = 0; i < limit; i++) {
        arr[i] = dataView.getUint16(p + i * 2, true)
      }
      return arr
    }
    case 0x63: // 'c'
      return new Int8Array(ba.buffer, absOffset, limit)
    case 0x43: // 'C'
      return new Uint8Array(ba.buffer, absOffset, limit)
    case 0x66: {
      // 'f'
      if (absOffset % 4 === 0) {
        return new Float32Array(ba.buffer, absOffset, limit)
      }
      const arr = new Array<number>(limit)
      for (let i = 0; i < limit; i++) {
        arr[i] = dataView.getFloat32(p + i * 4, true)
      }
      return arr
    }
    default:
      return undefined
  }
}

// Byte span of a 'B' tag's element payload, for advancing the cursor past it.
// Returns -1 for a subtype outside the spec's cCsSiIf, whose element width is
// unknowable. Guessing one byte per element (which is what falling through to
// `limit` did) doesn't skip the tag, it lands the cursor mid-value and decodes
// the whole rest of the record's tag list out of garbage — where an unknown
// top-level type has always stopped the walk instead. Same choice here.
function bArrayByteLength(Btype: number, limit: number) {
  if (Btype === 0x69 || Btype === 0x49 || Btype === 0x66) {
    return limit << 2
  } else if (Btype === 0x73 || Btype === 0x53) {
    return limit << 1
  } else if (Btype === 0x63 || Btype === 0x43) {
    return limit
  } else {
    return -1
  }
}

// Cursor position just past a tag's value — i.e. the start of the next tag —
// given the value starts at `p`. For null-terminated Z/H this steps over the
// terminator. Returns 0 for an unknown type, whose value width is unknowable so
// the caller must stop. Shared by _findTag and _computeTags so the two loops
// can't drift in how they walk the tag layout. (0 is an impossible real end:
// `p` is always past the fixed record prefix.)
function tagValueEnd(
  ba: Uint8Array,
  dataView: DataView,
  type: number,
  p: number,
  blockEnd: number,
) {
  switch (type) {
    case 0x41: // 'A'
    case 0x63: // 'c'
    case 0x43: // 'C'
      return p + 1
    case 0x73: // 's'
    case 0x53: // 'S'
      return p + 2
    case 0x69: // 'i'
    case 0x49: // 'I'
    case 0x66: {
      // 'f'
      return p + 4
    }
    case 0x5a: // 'Z'
    case 0x48: {
      // 'H'
      // Stays a plain byte loop. Swapping in Uint8Array.indexOf past a short
      // inline probe is 2.7x faster on long-read MD (mean 9083 bytes on
      // jb2bench's 200x.longread) but ~1.13x slower on short-read Z values,
      // which are 4-13 bytes and are what the dominant case is made of. Measured
      // both ways against the realistic corpus — see ADR 0012.
      let q = p
      while (q < blockEnd && ba[q] !== 0) {
        q++
      }
      return q + 1 // step past the null terminator
    }
    case 0x42: {
      // 'B'
      const Btype = ba[p]!
      const limit = dataView.getInt32(p + 1, true)
      const payload = bArrayByteLength(Btype, limit)
      if (payload < 0) {
        console.error('Unknown BAM B tag subtype', Btype)
        return 0
      }
      return p + 5 + payload
    }
    default:
      console.error('Unknown BAM tag type', type)
      return 0
  }
}

// Decode the value of a tag of `type` whose bytes start at `p`; `end` is the
// next-tag cursor from tagValueEnd (used only to bound Z/H strings, whose bytes
// run up to the null terminator at end-1). When `raw`, Z/H return the undecoded
// byte subarray. Assumes `type` is a known scalar/string/B type.
function decodeTagValue(
  ba: Uint8Array,
  dataView: DataView,
  type: number,
  p: number,
  end: number,
  raw: boolean,
): unknown {
  switch (type) {
    case 0x41: // 'A'
      return String.fromCharCode(ba[p]!)
    case 0x69: // 'i'
      return dataView.getInt32(p, true)
    case 0x49: // 'I'
      return dataView.getUint32(p, true)
    case 0x63: // 'c'
      return dataView.getInt8(p)
    case 0x43: // 'C'
      return dataView.getUint8(p)
    case 0x73: // 's'
      return dataView.getInt16(p, true)
    case 0x53: // 'S'
      return dataView.getUint16(p, true)
    case 0x66: // 'f'
      return dataView.getFloat32(p, true)
    case 0x5a: // 'Z'
    case 0x48: // 'H'
      return raw ? ba.subarray(p, end - 1) : decodeTagString(ba, p, end - 1)
    default: {
      // 'B'
      const Btype = ba[p]!
      const limit = dataView.getInt32(p + 1, true)
      return decodeBArrayTag(ba, dataView, p + 5, Btype, limit)
    }
  }
}

export default class BamRecord {
  public fileOffset: number
  private _byteArray: Uint8Array
  private _start: number
  private _end: number
  private _dataView: DataView

  private _cachedEnd?: number
  private _cachedTags?: Record<string, unknown>
  private _cachedLengthOnRef?: number
  private _cachedNumericCigar?: NumericCigar
  private _cachedNUMERIC_MD?: Uint8Array | null
  private _cachedSeqStart?: number

  // Positional rather than an options object, because every argument is
  // unpacked into a field immediately and nothing keeps the wrapper. The
  // options form allocated two throwaway objects for each of the ~200k records
  // a deep pileup decodes — the `{byteArray, start, end}` literal and the
  // `{bytes, fileOffset, dataView}` around it — purely to be taken apart again
  // one line later.
  constructor(
    byteArray: Uint8Array,
    start: number,
    end: number,
    fileOffset: number,
    dataView: DataView,
  ) {
    this._byteArray = byteArray
    this._start = start
    this._end = end
    this.fileOffset = fileOffset
    this._dataView = dataView
  }

  get byteArray() {
    return this._byteArray
  }

  get flags() {
    // FLAG is the high 16 bits of flag_nc (byte offset 18). Read it directly as
    // a uint16 — masking flag_nc and arithmetic-shifting would sign-extend any
    // value >= 0x8000.
    return this._dataView.getUint16(this._start + 18, true)
  }

  get ref_id() {
    return this._dataView.getInt32(this._start + 4, true)
  }

  get start() {
    return this._dataView.getInt32(this._start + 8, true)
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

  // QUAL is present whenever the record has bases — independent of the unmapped
  // flag (unmapped reads routinely carry SEQ/QUAL). A zero-length SEQ means
  // there is no quality to return.
  get qual() {
    const seqLen = this.seq_length
    if (seqLen === 0) {
      return null
    } else {
      const p = this.seqStart + ((seqLen + 1) >> 1)
      return this._byteArray.subarray(p, p + seqLen)
    }
  }

  get strand() {
    return this.isReverseComplemented() ? -1 : 1
  }

  get b0() {
    return this._start + 36
  }

  // start of the SEQ section (and end of CIGAR). All downstream sections
  // (qual, tags) are offsets from here, so cache once and reuse.
  get seqStart() {
    if (this._cachedSeqStart === undefined) {
      this._cachedSeqStart =
        this.b0 + this.read_name_length + this.num_cigar_bytes
    }
    return this._cachedSeqStart
  }

  get tagsStart() {
    const seqLen = this.seq_length
    return this.seqStart + ((seqLen + 1) >> 1) + seqLen
  }

  // batch fromCharCode: fastest for typical name lengths (see benchmarks/string-building.bench.ts)
  //
  // Deliberately NOT memoized, unlike end/tags/length_on_ref. Consumers read a
  // read name about once — jbrowse-components' buildBaseFeatureData copies it
  // straight into its own FeatureData — so a cache would pay a field slot on
  // every record (+180KB per 22k-record chunk) to save zero decodes, and would
  // pin every name string for as long as the chunk stays cached (+520KB) where
  // today it dies with the consumer's copy.
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
    const blockEnd = this._end
    const ba = this._byteArray
    let p = this.tagsStart
    while (p < blockEnd) {
      const isMatch = ba[p] === tag1 && ba[p + 1] === tag2
      const type = ba[p + 2]!
      const valueStart = p + 3
      const end = tagValueEnd(ba, this._dataView, type, valueStart, blockEnd)
      if (end === 0) {
        break // unknown type: can't compute how far to advance
      }
      if (isMatch) {
        return decodeTagValue(ba, this._dataView, type, valueStart, end, raw)
      }
      p = end
    }
    return undefined
  }

  private _computeTags() {
    const blockEnd = this._end
    const ba = this._byteArray
    // null prototype: tag names come from the file, so a read carrying a
    // "constructor" or "toString" tag must not resolve to Object.prototype's
    const tags: Record<string, unknown> = Object.create(null)
    let p = this.tagsStart
    while (p < blockEnd) {
      const tag = tagName(ba[p]!, ba[p + 1]!)
      const type = ba[p + 2]!
      const valueStart = p + 3
      const end = tagValueEnd(ba, this._dataView, type, valueStart, blockEnd)
      if (end === 0) {
        break // unknown type: can't compute how far to advance
      }
      tags[tag] = decodeTagValue(
        ba,
        this._dataView,
        type,
        valueStart,
        end,
        false,
      )
      p = end
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

  // CG tag pattern: first op is soft-clip consuming entire sequence, second op is N encoding length-on-ref
  private _isCGTagPattern(p: number, numCigarOps: number) {
    // htslib stores the placeholder as exactly two ops: <seqlen>S<reflen>N.
    if (numCigarOps === 2) {
      const cigop = this._dataView.getInt32(p, true)
      return (cigop & 0xf) === CIGAR_SOFT_CLIP && cigop >> 4 === this.seq_length
    } else {
      return false
    }
  }

  private _computeLengthOnRef(): number {
    const flag_nc = this._dataView.getInt32(this._start + 16, true)
    if (flag_nc & (Constants.BAM_FUNMAP << 16)) {
      return 0
    }

    const numCigarOps = flag_nc & 0xffff
    const p = this.b0 + this.read_name_length

    if (this._isCGTagPattern(p, numCigarOps)) {
      const cigop2 = this._dataView.getInt32(p + 4, true)
      if ((cigop2 & 0xf) !== CIGAR_REF_SKIP) {
        console.warn('CG tag with no N tag')
      }
      return cigop2 >> 4
    }

    const absOffset = this._byteArray.byteOffset + p
    if (absOffset % 4 === 0 && numCigarOps > 50) {
      const cigarView = new Uint32Array(
        this._byteArray.buffer,
        absOffset,
        numCigarOps,
      )
      // the view we need to sum is exactly what NUMERIC_CIGAR would build, so
      // seed its cache rather than making it construct a second one
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

  // Unmapped records are not special-cased here, unlike in
  // _computeLengthOnRef. The spec says no assumptions can be made about an
  // unmapped read's CIGAR, but "no assumptions" is not "no CIGAR": aligners
  // emit placed unmapped mates that carry a real one, and htslib prints
  // whatever is stored. Dropping it lost data the file had — paired.bam's
  // SRR062635.1831187 at 20:74230 is FLAG 133 with 35M65S.
  //
  // Reference span stays 0 for them regardless, since that is a claim about
  // alignment rather than about the stored bytes, and the query filter reads
  // it.
  private _computeNumericCigar(): NumericCigar {
    const flag_nc = this._dataView.getInt32(this._start + 16, true)
    const numCigarOps = flag_nc & 0xffff
    const p = this.b0 + this.read_name_length

    if (this._isCGTagPattern(p, numCigarOps)) {
      // getTag, not this.tags: the real CIGAR lives in one tag, so there's no
      // reason to decode every other tag on the record to reach it
      const cg = this.getTag('CG')
      return isNumericCigar(cg) ? cg : new Uint32Array(0)
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

  // Two appends per op, NOT `result += length + String.fromCharCode(op)`. The
  // one-append form builds an intermediate cons string per op just to append it
  // and drop it; appending each piece straight onto the rope is 1.23-1.35x
  // faster on long reads, which is where this accessor dominates
  // (chr22_nanopore_subset 51.2 -> 38.6 ms for 757 reads averaging 2171 ops,
  // ultra-long-ont 13.2 -> 9.9 ms). Short reads carry 1-3 ops and land inside
  // this box's noise band either way.
  //
  // ADR 0003 rejected two other rewrites of this loop — a precomputed 16-entry
  // op-char table, and digits into a Uint8Array with one TextDecoder.decode —
  // and both are still losers. Re-measured here: the op-char table is 1.13x
  // SLOWER than String.fromCharCode even on top of this change, because V8
  // already hands back an interned single-character string.
  get CIGAR() {
    const numeric = this.NUMERIC_CIGAR
    let result = ''
    for (let i = 0, l = numeric.length; i < l; i++) {
      const packed = numeric[i]!
      result += packed >> 4
      result += String.fromCharCode(ASCII_CIGAR_CODES[packed & 0xf]!)
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
    const p = this.seqStart
    return this._byteArray.subarray(p, p + this.num_seq_bytes)
  }

  // Decode four bases per iteration off the 65536-entry table (two off the
  // 256-entry one until that table has warmed up). Building an array of 1-char
  // strings and join()ing it — the obvious approach — is 3x slower at 100bp and
  // 35x slower at 15kb.
  get seq() {
    const len = this.seq_length
    const ba = this._byteArray
    const p = this.seqStart
    const nPairs = len >> 1
    let seq: string
    if (len < SEQ_DECODER_THRESHOLD) {
      const quads = seqretQuads()
      seq = ''
      if (quads === undefined) {
        for (let j = 0; j < nPairs; j++) {
          seq += SEQRET_PAIR_STRINGS[ba[p + j]!]!
        }
      } else {
        const nQuads = nPairs >> 1
        for (let j = 0; j < nQuads; j++) {
          const q = p + 2 * j
          seq += quads[(ba[q]! << 8) | ba[q + 1]!]!
        }
        // odd byte count: two more bases off the 2-base table
        if (nPairs & 1) {
          seq += SEQRET_PAIR_STRINGS[ba[p + nPairs - 1]!]!
        }
      }
      if (len & 1) {
        seq += SEQRET_DECODER[(ba[p + nPairs]! & 0xf0) >> 4]!
      }
    } else {
      // round up to an even length so the Uint16Array view spans every pair; a
      // trailing odd base is written as a single byte and trimmed on decode
      const out = new Uint8Array((len + 1) & ~1)
      const pairs = new Uint16Array(out.buffer)
      for (let j = 0; j < nPairs; j++) {
        pairs[j] = SEQRET_PAIR_CODES[ba[p + j]!]!
      }
      if (len & 1) {
        out[len - 1] = SEQRET_CODES[(ba[p + nPairs]! & 0xf0) >> 4]!
      }
      seq = textDecoder.decode(out.subarray(0, len))
    }
    return seq
  }

  // Must come out identical from either mate, or the two halves of one normal
  // pair render as different orientations. The leftmost mate is therefore picked
  // by a total order on (refId, pos) that both mates evaluate the same way, with
  // a read1-first tie-break for equal loci.
  //
  // Deriving "leftmost" from template_length looks tempting — the spec makes
  // tlen positive for the leftmost segment and negative for the rightmost — but
  // aligners leave tlen at 0 whenever the insert size is unavailable, which
  // includes every cross-reference pair. Both mates then read as "not leftmost"
  // and disagree with each other.
  // (see also: gmod/cram-js src/cramFile/record.ts getPairOrientation)
  get pair_orientation() {
    const f = this.flags
    if (!(f & Constants.BAM_FPAIRED)) {
      return undefined
    }
    const refId = this.ref_id
    const mateRefId = this.next_refid
    const pos = this.start
    const matePos = this.next_pos
    const selfIsLeft =
      refId !== mateRefId
        ? refId < mateRefId
        : pos !== matePos
          ? pos < matePos
          : !!(f & Constants.BAM_FREAD1)
    return PAIR_ORIENTATION_TABLE[((f >> 4) & 0x7) | (selfIsLeft ? 8 : 0)]
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
      const sb = this._byteArray[this.seqStart + (idx >> 1)]!

      return (idx & 1) === 0
        ? SEQRET_DECODER[(sb & 0xf0) >> 4]!
        : SEQRET_DECODER[sb & 0x0f]!
    } else {
      return undefined
    }
  }

  // Most public BamRecord fields are getters on the prototype, so
  // Object.keys(this) wouldn't include them — JSON.stringify needs an explicit
  // list. Returns the meaningful BAM-spec fields. Return type is widened so
  // subclasses can override with their own serialized shape.
  toJSON(): Record<string, unknown> {
    return {
      fileOffset: this.fileOffset,
      ref_id: this.ref_id,
      start: this.start,
      end: this.end,
      name: this.name,
      flags: this.flags,
      mq: this.mq,
      CIGAR: this.CIGAR,
      seq: this.seq,
      next_refid: this.next_refid,
      next_pos: this.next_pos,
      template_length: this.template_length,
      tags: this.tags,
    }
  }
}
