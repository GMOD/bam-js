import { SEQRET } from './seqAlphabet.ts'

/**
 * A region of reference sequence in BAM's own 4-bit alphabet, so the mismatch
 * walk can compare it against a read's already-packed `NUMERIC_SEQ` a byte —
 * two bases — at a time, instead of unpacking a nibble and reading a string
 * character per base. Only the rare byte that differs gets unpacked.
 *
 * Two packings, because a read's sequence parity and its reference parity need
 * not agree: `even[i]` holds region bases (2i, 2i+1), `odd[i]` holds
 * (2i-1, 2i). The walk picks whichever lines the reference pair up with the
 * read's byte boundary. Together they cost one byte per base, the same as the
 * region string they replace.
 *
 * Build one with {@link packReference}, per region rather than per read: a
 * pileup's reads all resolve against the same region, and packing is the only
 * per-base pass in the whole walk.
 */
export interface PackedReference {
  /** 0-based reference coordinate of the first base */
  start: number
  /** length in bases, i.e. of the string this was packed from */
  length: number
  even: Uint8Array
  odd: Uint8Array
}

// ASCII -> 4-bit code, case-insensitive. Anything outside the alphabet reads as
// N, which mismatches every concrete base — what an unrecognized character does
// when the comparison is done in ASCII.
const NIBBLE_FROM_CHAR = new Uint8Array(256).fill(15)
for (let i = 0; i < 16; i++) {
  NIBBLE_FROM_CHAR[SEQRET.charCodeAt(i)] = i
  NIBBLE_FROM_CHAR[SEQRET.charCodeAt(i) | 0x20] = i
}

/**
 * The 4-bit codes back to ASCII, for reporting a mismatch's reference base.
 * Always the uppercase spelling: packing is case-insensitive, so a soft-masked
 * reference reports `A` where the raw string would have said `a`.
 */
export const CHAR_CODE_FROM_NIBBLE = new Uint8Array(16)
for (let i = 0; i < 16; i++) {
  CHAR_CODE_FROM_NIBBLE[i] = SEQRET.charCodeAt(i)
}

/**
 * Pack a region of reference sequence for {@link PackedReference}.
 *
 * @param seq the reference bases, case-insensitive
 * @param start the 0-based reference coordinate `seq[0]` sits at
 */
export function packReference(seq: string, start = 0): PackedReference {
  const n = seq.length
  const even = new Uint8Array((n >> 1) + 1)
  const odd = new Uint8Array((n >> 1) + 1)
  for (let i = 0; i < n; i++) {
    const code = seq.charCodeAt(i)
    const nibble = code < 256 ? NIBBLE_FROM_CHAR[code]! : 15
    if (i & 1) {
      even[i >> 1]! |= nibble
      odd[(i + 1) >> 1] = nibble << 4
    } else {
      even[i >> 1] = nibble << 4
      odd[i >> 1]! |= nibble
    }
  }
  return { start, length: n, even, odd }
}

/**
 * The single reference base at region-relative index `i`, for the ends of an
 * odd-length run. Callers bound `i` to the region themselves — reading past the
 * end would report a base the region does not have.
 */
export function referenceNibble(ref: PackedReference, i: number) {
  return (ref.even[i >> 1]! >> ((1 - (i & 1)) << 2)) & 0xf
}

/** whether `ref` covers every base of the 0-based half-open span [start, end) */
export function referenceCovers(
  ref: PackedReference,
  start: number,
  end: number,
) {
  return ref.start <= start && ref.start + ref.length >= end
}
