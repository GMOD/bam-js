export { default as BAI } from './bai.ts'
export { default as BamFile } from './bamFile.ts'
export { default as BlockFeatureCache } from './blockFeatureCache.ts'
export { default as CSI } from './csi.ts'
export { default as BamRecord } from './record.ts'
export { default as HtsgetFile } from './htsget.ts'

// Re-export ByteCache from bgzf-filehandle for backwards compatibility
export { ByteCache } from '@gmod/bgzf-filehandle'

export type { Bytes } from './record.ts'
export type { FilterBy, TagFilter } from './util.ts'
export type { BamRecordClass, BamRecordLike } from './bamFile.ts'
export type { BlockFeatureCacheConfig } from './blockFeatureCache.ts'
export type { ByteCacheConfig } from '@gmod/bgzf-filehandle'
