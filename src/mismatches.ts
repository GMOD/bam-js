import {
  CIGAR_DEL,
  CIGAR_DIFF,
  CIGAR_EQUAL,
  CIGAR_HARD_CLIP,
  CIGAR_INS,
  CIGAR_MATCH,
  CIGAR_REF_SKIP,
  CIGAR_SOFT_CLIP,
} from './cigar.ts'
import { CHAR_CODE_FROM_NIBBLE, referenceNibble } from './reference.ts'
import { SEQRET_DECODER } from './seqAlphabet.ts'

import type { PackedReference } from './reference.ts'

/**
 * The kind of difference a {@link Mismatch} reports, as the CIGAR-style char
 * code it corresponds to. `@gmod/cram`'s `forEachMismatch` emits the same
 * values (its `RF_*` constants), so one `switch` handles records from either
 * format.
 *
 * Note these are char codes and NOT the packed-CIGAR op numbers in `cigar.ts`
 * — `MISMATCH_DELETION` is 68 (`'D'`), where `CIGAR_DEL` is 2.
 */
export const MISMATCH_SUBST = 88 // 'X'
export const MISMATCH_INSERTION = 73 // 'I'
export const MISMATCH_DELETION = 68 // 'D'
export const MISMATCH_REF_SKIP = 78 // 'N'
export const MISMATCH_SOFT_CLIP = 83 // 'S'
export const MISMATCH_HARD_CLIP = 72 // 'H'

/**
 * One difference between a read and the reference, as
 * {@link BamRecord.getMismatches} reports it.
 *
 * This is the level most consumers want. Deriving the same thing from `CIGAR`
 * and `MD` yourself means knowing that MD counts reference bases and the CIGAR
 * counts both, that MD is absent from a majority of aligners' output and the
 * reference has to stand in for it, that an `=`/`X` CIGAR carries the
 * substitutions itself, and that a deletion's MD payload has to be stepped over
 * rather than read as matches. Every one of those has been a bug in a
 * downstream consumer.
 */
export interface Mismatch {
  /**
   * Which kind of difference: `MISMATCH_SUBST` (X), `MISMATCH_INSERTION` (I),
   * `MISMATCH_DELETION` (D), `MISMATCH_REF_SKIP` (N), `MISMATCH_SOFT_CLIP` (S)
   * or `MISMATCH_HARD_CLIP` (H). A substitution arrives as `MISMATCH_SUBST`
   * whether the file spelled it with MD, with an `X` CIGAR op, or not at all
   * (leaving it to be found against the reference).
   */
  code: number
  /** 0-based reference position the difference starts at */
  refPos: number
  /**
   * How many reference bases it covers: 1 for a substitution, the deleted or
   * skipped length for D/N, and 0 for insertions and clips, which consume read
   * bases without consuming reference.
   */
  length: number
  /**
   * The substituted base for X, or the inserted bases for I; empty for
   * D/N/S/H, which have no bases of their own to report. Also empty for an
   * insertion in a read with no stored sequence (`SEQ` of `*`), where the
   * length is all the file kept.
   */
  bases: string
  /** quality score of a substituted base, or -1 when the read stores none */
  qual: number
  /**
   * Char code of the reference base a substitution replaces, 0 when unknown —
   * which is what an `X` CIGAR op in a read carrying neither an MD tag nor a
   * reference gives. Upper-cased, since a soft-masked reference would otherwise
   * report lowercase.
   */
  refBaseCode: number
  /** read bases consumed: the inserted or clipped length; 0 otherwise */
  clipLength: number
}

export type MismatchCallback = (
  code: number,
  refPos: number,
  length: number,
  bases: string,
  qual: number,
  refBaseCode: number,
  clipLength: number,
) => void

export interface MismatchOptions {
  /**
   * Only report differences touching this reference range, 0-based and
   * half-open like every other range this library takes. A deletion or skip is
   * reported when any of the bases it covers falls in the range; everything
   * else when its own position does.
   *
   * (`@gmod/cram`'s equivalent option is **closed** at `end` — a known wart
   * over there, tracked in its TODO.md. Half-open is the one to write new code
   * against.)
   */
  start?: number
  end?: number
  /**
   * Reference bases to resolve substitutions against, for reads with no MD tag.
   * Overrides whatever {@link BamRecord.setReference} bound, and unlike that
   * method it takes a region of any extent: bases outside it are simply left
   * uncompared. Pack it once per region with `packReference`, not per read.
   */
  ref?: PackedReference
}

// M and = both mean "aligned to the reference", differing only in whether the
// file promises the bases match. Which is exactly the distinction MD (or the
// reference) exists to settle, so the walk treats them identically.
const CIGAR_M_EQ_MASK = (1 << CIGAR_MATCH) | (1 << CIGAR_EQUAL)

// A clip has no bases to report — its length travels in `clipLength`, which is
// what every consumer reads.
const NO_BASES = ''

function reportRefMismatch(
  callback: MismatchCallback,
  refPos: number,
  seqNibble: number,
  qual: number,
  refNibble: number,
) {
  callback(
    MISMATCH_SUBST,
    refPos,
    1,
    SEQRET_DECODER[seqNibble]!,
    qual,
    CHAR_CODE_FROM_NIBBLE[refNibble]!,
    0,
  )
}

// One base compared on its own: the ends of a run whose length or alignment
// leaves it without a partner in the same byte.
function compareRefBase(
  callback: MismatchCallback,
  numericSeq: ArrayLike<number>,
  qual: ArrayLike<number> | null | undefined,
  ref: PackedReference,
  seqIdx: number,
  refIdx: number,
  refPos: number,
) {
  const seqNibble =
    (numericSeq[seqIdx >> 1]! >> ((1 - (seqIdx & 1)) << 2)) & 0xf
  const refNibble = referenceNibble(ref, refIdx)
  if (seqNibble !== refNibble) {
    reportRefMismatch(
      callback,
      refPos,
      seqNibble,
      qual ? qual[seqIdx]! : -1,
      refNibble,
    )
  }
}

/**
 * The mismatch walk over a record's already-packed fields, for callers holding
 * BAM's arrays without a {@link BamRecord} around them — a SAM parser, or a
 * worker that was handed the typed arrays rather than the record.
 * `record.forEachMismatch()` is this function with the record's own fields
 * filled in, and is what most code should call.
 *
 * Nothing here allocates per difference except the `bases` string, and that
 * only for substitutions and insertions.
 *
 * @param cigar packed CIGAR ops, i.e. `record.NUMERIC_CIGAR`
 * @param numericSeq 4-bit packed SEQ, i.e. `record.NUMERIC_SEQ`
 * @param seqLength bases in `numericSeq`; 0 for a read stored with `SEQ` of `*`
 * @param md the MD tag's bytes (`record.NUMERIC_MD`), or undefined. Preferred
 *   over `ref` when present, being both cheaper and what the aligner asserted
 * @param qual per-base quality scores, or null/undefined when the read has none
 * @param ref reference bases to compare against when there is no MD tag. Bases
 *   the region does not cover are left uncompared
 * @param refStart the record's own 0-based start, which every reported position
 *   is relative to
 * @param windowStart 0-based half-open reference window to report within. Pass
 *   `-Infinity`/`Infinity` for the whole read; a viewport that clips the walk
 *   is what keeps a chromosome-spanning contig alignment from being walked in
 *   full for every screenful
 * @param windowEnd
 * @param callback `(code, refPos, length, bases, qual, refBaseCode, clipLength)`
 */
export function forEachMismatchNumeric(
  cigar: ArrayLike<number>,
  numericSeq: ArrayLike<number>,
  seqLength: number,
  md: ArrayLike<number> | undefined,
  qual: ArrayLike<number> | null | undefined,
  ref: PackedReference | undefined,
  refStart: number,
  windowStart: number,
  windowEnd: number,
  callback: MismatchCallback,
) {
  // The walk runs in read-relative offsets — `roffset` reference bases and
  // `soffset` read bases consumed — and converts back at the callback, so the
  // window is converted once here rather than per op.
  //
  // Clamped to int32 rather than left at the ±Infinity an unwindowed walk
  // passes, because every op of the walk compares an offset against these and
  // Infinity makes each of those a Float64 comparison. BAM positions are int32,
  // so this cannot narrow a window anyone can express.
  const winLo =
    windowStart <= -0x80000000 ? -0x80000000 : windowStart - refStart
  const winHi = windowEnd >= 0x7fffffff ? 0x7fffffff : windowEnd - refStart

  // Fast path for reads with no sequence (e.g. secondary alignments with SEQ='*')
  if (seqLength === 0) {
    let roffset = 0
    for (let i = 0, l = cigar.length; i < l; i++) {
      // `roffset` only grows, and nothing at or past the window's right edge is
      // reported, so the rest of the CIGAR cannot produce anything (see the
      // same check in the main loop)
      if (roffset >= winHi) {
        break
      }
      const packed = cigar[i]!
      const len = packed >>> 4
      const op = packed & 0xf
      // X consumes the reference exactly like M/=; without a sequence there are
      // no bases to report for it, but it still has to advance — leaving it out
      // shifted every later op left by the total X length, which is every indel
      // in an --eqx CIGAR walked without a sequence.
      if ((1 << op) & CIGAR_M_EQ_MASK || op === CIGAR_DIFF) {
        roffset += len
      } else if (op === CIGAR_INS) {
        if (roffset >= winLo && roffset < winHi) {
          callback(MISMATCH_INSERTION, refStart + roffset, 0, '', -1, 0, len)
        }
      } else if (op === CIGAR_DEL) {
        if (roffset < winHi && roffset + len > winLo) {
          callback(
            MISMATCH_DELETION,
            refStart + roffset,
            len,
            NO_BASES,
            -1,
            0,
            0,
          )
        }
        roffset += len
      } else if (op === CIGAR_REF_SKIP) {
        if (roffset < winHi && roffset + len > winLo) {
          callback(
            MISMATCH_REF_SKIP,
            refStart + roffset,
            len,
            NO_BASES,
            -1,
            0,
            0,
          )
        }
        roffset += len
      } else if (op === CIGAR_SOFT_CLIP) {
        if (roffset >= winLo && roffset < winHi) {
          callback(
            MISMATCH_SOFT_CLIP,
            refStart + roffset,
            0,
            NO_BASES,
            -1,
            0,
            len,
          )
        }
      } else if (op === CIGAR_HARD_CLIP) {
        if (roffset >= winLo && roffset < winHi) {
          callback(
            MISMATCH_HARD_CLIP,
            refStart + roffset,
            0,
            NO_BASES,
            -1,
            0,
            len,
          )
        }
      }
    }
    return
  }

  const mdLength = md?.length ?? 0
  const hasQual = !!qual
  const hasMD = md && mdLength > 0

  // Where the reference region sits in read-relative offsets, and the window
  // narrowed to it. Only base COMPARISON is bounded by the region — an indel or
  // a clip needs no reference base, so a region covering part of a read still
  // reports every one of them.
  //
  // Ternaries rather than Math.max/Math.min, which matters more than it looks:
  // an unwindowed walk has `winLo`/`winHi` at ±Infinity, so Math.min would hand
  // back a Float64 and `cmpHi` would carry that all the way into `jHi`, the
  // bound of the innermost (two-bases-per-byte) loop. This way an unwindowed
  // walk keeps that bound a Smi, which measured ~8% of the reference path on
  // dense short reads.
  let refOffset = 0
  let cmpLo = 0
  let cmpHi = 0
  if (ref !== undefined) {
    refOffset = refStart - ref.start
    const refLo = -refOffset
    const refHi = ref.length - refOffset
    cmpLo = winLo > refLo ? winLo : refLo
    cmpHi = winHi < refHi ? winHi : refHi
  }

  let roffset = 0
  let soffset = 0
  let mdIdx = 0
  let mdMatchRemaining = 0

  if (hasMD) {
    while (mdIdx < mdLength) {
      const c = md[mdIdx]!
      if (c >= 48 && c <= 57) {
        mdMatchRemaining = mdMatchRemaining * 10 + (c - 48)
        mdIdx++
      } else {
        break
      }
    }
  }

  for (let i = 0, l = cigar.length; i < l; i++) {
    // Stop at the window's right edge rather than walking the rest of the
    // CIGAR: `roffset` only grows, and every report below needs
    // `roffset < winHi`, so nothing past here can produce anything. Matters for
    // a whole chromosome stored as one BAM read, whose CIGAR runs to millions
    // of ops for a screenful of them — and costs one compare per op otherwise,
    // since an unwindowed walk has `winHi` at +Infinity.
    if (roffset >= winHi) {
      break
    }
    const packed = cigar[i]!
    const len = packed >>> 4
    const op = packed & 0xf

    if ((1 << op) & CIGAR_M_EQ_MASK) {
      if (hasMD) {
        let remaining = len
        let localOffset = 0

        while (remaining > 0) {
          if (mdMatchRemaining >= remaining) {
            mdMatchRemaining -= remaining
            localOffset += remaining
            remaining = 0
          } else {
            localOffset += mdMatchRemaining
            remaining -= mdMatchRemaining
            mdMatchRemaining = 0

            if (mdIdx < mdLength && md[mdIdx]! >= 65 && md[mdIdx]! <= 90) {
              const pos = roffset + localOffset
              if (pos >= winLo && pos < winHi) {
                const seqIdx = soffset + localOffset
                const sb = numericSeq[seqIdx >> 1]!
                const nibble = (sb >> ((1 - (seqIdx & 1)) << 2)) & 0xf

                callback(
                  MISMATCH_SUBST,
                  refStart + pos,
                  1,
                  SEQRET_DECODER[nibble]!,
                  hasQual ? qual[seqIdx]! : -1,
                  md[mdIdx]!,
                  0,
                )
              }

              mdIdx++
              localOffset++
              remaining--
              mdMatchRemaining = 0
              while (mdIdx < mdLength) {
                const c = md[mdIdx]!
                if (c >= 48 && c <= 57) {
                  mdMatchRemaining = mdMatchRemaining * 10 + (c - 48)
                  mdIdx++
                } else {
                  break
                }
              }
            } else {
              break
            }
          }
        }
      } else if (ref) {
        // Only compare bases whose reference position falls in the window AND
        // in the region. A whole-chromosome contig has M ops totalling ~250M
        // bases; without this clip every one is compared (and `ref` would have
        // to cover the whole chromosome).
        const jLo = cmpLo > roffset ? cmpLo - roffset : 0
        const jHi = cmpHi < roffset + len ? cmpHi - roffset : len
        let j = jLo
        // A leading odd read index has no partner in its byte, so compare it
        // alone and let the pair loop start on a byte boundary.
        if (j < jHi && (soffset + j) & 1) {
          compareRefBase(
            callback,
            numericSeq,
            qual,
            ref,
            soffset + j,
            refOffset + roffset + j,
            refStart + roffset + j,
          )
          j++
        }
        // Two bases per byte load and compare. `even`/`odd` differ only in
        // which reference parity they put on a byte boundary, so one of them
        // always lines up with the read's packed sequence; the nibbles are
        // unpacked only for the byte that actually differs.
        const refIdx = refOffset + roffset + j
        const refPairs = refIdx & 1 ? ref.odd : ref.even
        let refByte = (refIdx + (refIdx & 1)) >> 1
        let seqByte = (soffset + j) >> 1
        for (; j + 1 < jHi; j += 2, refByte++, seqByte++) {
          const seqPair = numericSeq[seqByte]!
          const refPair = refPairs[refByte]!
          if (seqPair !== refPair) {
            const seqHi = (seqPair >> 4) & 0xf
            const refHi = (refPair >> 4) & 0xf
            if (seqHi !== refHi) {
              reportRefMismatch(
                callback,
                refStart + roffset + j,
                seqHi,
                hasQual ? qual[soffset + j]! : -1,
                refHi,
              )
            }
            const seqLo = seqPair & 0xf
            const refLo = refPair & 0xf
            if (seqLo !== refLo) {
              reportRefMismatch(
                callback,
                refStart + roffset + j + 1,
                seqLo,
                hasQual ? qual[soffset + j + 1]! : -1,
                refLo,
              )
            }
          }
        }
        if (j < jHi) {
          compareRefBase(
            callback,
            numericSeq,
            qual,
            ref,
            soffset + j,
            refOffset + roffset + j,
            refStart + roffset + j,
          )
        }
      }
      soffset += len
      roffset += len
    } else if (op === CIGAR_INS) {
      if (roffset >= winLo && roffset < winHi) {
        // Optimized insertion base extraction - avoid string concat for common
        // cases
        let insertedBases: string
        if (len === 1) {
          // Single base insertion - most common case
          const sb = numericSeq[soffset >> 1]!
          const nibble = (sb >> ((1 - (soffset & 1)) << 2)) & 0xf
          insertedBases = SEQRET_DECODER[nibble]!
        } else if (len === 2) {
          // Two base insertion - second most common
          const seqIdx0 = soffset
          const sb0 = numericSeq[seqIdx0 >> 1]!
          const nibble0 = (sb0 >> ((1 - (seqIdx0 & 1)) << 2)) & 0xf
          const seqIdx1 = soffset + 1
          const sb1 = numericSeq[seqIdx1 >> 1]!
          const nibble1 = (sb1 >> ((1 - (seqIdx1 & 1)) << 2)) & 0xf
          insertedBases = SEQRET_DECODER[nibble0]! + SEQRET_DECODER[nibble1]!
        } else {
          const bases = new Array<string>(len)
          for (let j = 0; j < len; j++) {
            const seqIdx = soffset + j
            const sb = numericSeq[seqIdx >> 1]!
            const nibble = (sb >> ((1 - (seqIdx & 1)) << 2)) & 0xf
            bases[j] = SEQRET_DECODER[nibble]!
          }
          insertedBases = bases.join('')
        }
        callback(
          MISMATCH_INSERTION,
          refStart + roffset,
          0,
          insertedBases,
          -1,
          0,
          len,
        )
      }
      soffset += len
    } else if (op === CIGAR_DEL) {
      if (roffset < winHi && roffset + len > winLo) {
        callback(MISMATCH_DELETION, refStart + roffset, len, NO_BASES, -1, 0, 0)
      }

      // MD spells a deletion as ^ then the deleted reference bases, which are
      // not a difference this reports (the D above already is) but do have to
      // be stepped over, or every later position in the read reads off the
      // wrong part of the tag.
      // eslint-disable-next-line @typescript-eslint/no-confusing-non-null-assertion
      if (hasMD && mdIdx < mdLength && md[mdIdx]! === 94) {
        mdIdx++
        while (mdIdx < mdLength && md[mdIdx]! >= 65) {
          mdIdx++
        }
        mdMatchRemaining = 0
        while (mdIdx < mdLength) {
          const c = md[mdIdx]!
          if (c >= 48 && c <= 57) {
            mdMatchRemaining = mdMatchRemaining * 10 + (c - 48)
            mdIdx++
          } else {
            break
          }
        }
      }
      roffset += len
    } else if (op === CIGAR_REF_SKIP) {
      if (roffset < winHi && roffset + len > winLo) {
        callback(MISMATCH_REF_SKIP, refStart + roffset, len, NO_BASES, -1, 0, 0)
      }
      roffset += len
    } else if (op === CIGAR_DIFF) {
      for (let j = 0; j < len; j++) {
        const seqIdx = soffset + j
        const sb = numericSeq[seqIdx >> 1]!
        const nibble = (sb >> ((1 - (seqIdx & 1)) << 2)) & 0xf

        // An X op says a substitution is here without saying what it replaces,
        // so the reference base comes from MD or the region — and is 0, i.e.
        // unknown, when the read carries neither.
        let refBaseCode = 0
        if (hasMD) {
          if (mdMatchRemaining === 0 && mdIdx < mdLength && md[mdIdx]! >= 65) {
            refBaseCode = md[mdIdx]!
            mdIdx++
            mdMatchRemaining = 0
            while (mdIdx < mdLength) {
              const c = md[mdIdx]!
              if (c >= 48 && c <= 57) {
                mdMatchRemaining = mdMatchRemaining * 10 + (c - 48)
                mdIdx++
              } else {
                break
              }
            }
          } else if (mdMatchRemaining > 0) {
            mdMatchRemaining--
          }
        } else if (ref) {
          const refIdx = refOffset + roffset + j
          if (refIdx >= 0 && refIdx < ref.length) {
            refBaseCode = CHAR_CODE_FROM_NIBBLE[referenceNibble(ref, refIdx)]!
          }
        }

        const pos = roffset + j
        if (pos >= winLo && pos < winHi) {
          callback(
            MISMATCH_SUBST,
            refStart + pos,
            1,
            SEQRET_DECODER[nibble]!,
            hasQual ? qual[seqIdx]! : -1,
            refBaseCode,
            0,
          )
        }
      }
      soffset += len
      roffset += len
    } else if (op === CIGAR_SOFT_CLIP) {
      if (roffset >= winLo && roffset < winHi) {
        callback(
          MISMATCH_SOFT_CLIP,
          refStart + roffset,
          0,
          NO_BASES,
          -1,
          0,
          len,
        )
      }
      soffset += len
    } else if (op === CIGAR_HARD_CLIP) {
      if (roffset >= winLo && roffset < winHi) {
        callback(
          MISMATCH_HARD_CLIP,
          refStart + roffset,
          0,
          NO_BASES,
          -1,
          0,
          len,
        )
      }
    }
    // P (padding) consumes neither read nor reference and is not a difference
  }
}
