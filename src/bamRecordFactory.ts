export interface Bytes {
  start: number
  end: number
  byteArray: Uint8Array
}

export interface BamRecordLike {
  ref_id: number
  start: number
  end: number
  id: number
  name: string
  next_refid: number
  next_pos: number
  seq: string
  qual: Uint8Array | undefined
  CIGAR: string
  tags: Record<string, unknown>
  flags: number
  mq: number | undefined
  seq_length: number
}

export interface BamRecordConstructorArgs {
  bytes: Bytes
  fileOffset: number
}

export type BamRecordFactory<T extends BamRecordLike = BamRecordLike> = (
  args: BamRecordConstructorArgs,
) => T
