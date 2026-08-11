export { default as BAI } from './bai.ts'
export {
  DEFAULT_CACHE_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CACHE_BYTES,
  default as BamFile,
} from './bamFile.ts'
export { default as CSI } from './csi.ts'
export { default as BamRecord } from './record.ts'
export { default as HtsgetFile } from './htsget.ts'

// The mismatch walk, and the codes it reports differences as. The walk is
// exported alongside `record.forEachMismatch` for callers holding BAM's packed
// arrays without a record around them — a SAM parser, or a worker that was
// posted the typed arrays.
export {
  MISMATCH_DELETION,
  MISMATCH_HARD_CLIP,
  MISMATCH_INSERTION,
  MISMATCH_REF_SKIP,
  MISMATCH_SOFT_CLIP,
  MISMATCH_SUBST,
  forEachMismatchNumeric,
} from './mismatches.ts'
// `referenceNibble` and `CHAR_CODE_FROM_NIBBLE` are what read a base back out
// of a packed region — a consumer that holds one otherwise has no way to see
// what is in it, which makes a binding untestable from the outside.
export {
  CHAR_CODE_FROM_NIBBLE,
  packReference,
  referenceNibble,
} from './reference.ts'

export type { NumericCigar } from './record.ts'
export type {
  BamRecordClass,
  BamRecordLike,
  ReferenceSequenceFetcher,
} from './bamFile.ts'
export type {
  Mismatch,
  MismatchCallback,
  MismatchOptions,
} from './mismatches.ts'
export type { PackedReference } from './reference.ts'
// the options every query method takes, and the shapes they hand back. The
// package has no subpath exports, so a consumer typing a wrapper around
// getRecordsForRange/indexCov can only name these if they come out of here.
export type { BamOpts, BaseOpts } from './util.ts'
export type { IndexCovEntry } from './bai.ts'
// for typing the HtsgetFile `fetch` option
export type { Fetcher } from 'generic-filehandle2'
