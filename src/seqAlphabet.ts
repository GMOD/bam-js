// BAM's 4-bit sequence alphabet (SAM spec §4.2, `seq`): nibble value -> base.
//
// Shared rather than duplicated because three modules need it for three
// different shapes — `record.ts` builds pair/quad tables on top of it to decode
// whole reads, `reference.ts` inverts it to pack a reference the same way, and
// `mismatches.ts` reads single bases out of it — and a copy that drifted would
// silently mis-decode one of them.
export const SEQRET = '=ACMGRSVTWYHKDBN'
export const SEQRET_DECODER = SEQRET.split('')
export const SEQRET_CODES = Uint8Array.from(SEQRET, c => c.charCodeAt(0))
