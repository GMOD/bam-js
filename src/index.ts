export { default as BAI } from './bai.ts'
export {
  DEFAULT_CACHE_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CACHE_BYTES,
  default as BamFile,
} from './bamFile.ts'
export { default as CSI } from './csi.ts'
export { default as BamRecord } from './record.ts'
export { default as HtsgetFile } from './htsget.ts'

export type { NumericCigar } from './record.ts'
export type { BamRecordClass, BamRecordLike } from './bamFile.ts'
// the options every query method takes, and the shapes they hand back. The
// package has no subpath exports, so a consumer typing a wrapper around
// getRecordsForRange/indexCov can only name these if they come out of here.
export type { BamOpts, BaseOpts } from './util.ts'
export type { IndexCovEntry } from './bai.ts'
// for typing the HtsgetFile `fetch` option
export type { Fetcher } from 'generic-filehandle2'
