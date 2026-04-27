import { Buffer } from 'buffer'

import Record from '../src/record.ts'

export default class FakeRecord extends Record {
  private tlen: number
  private nextrefid: number
  private refid: number
  private _flags: number

  constructor(
    read1: boolean,
    strand1: string,
    strand2: string,
    tlen: number,
    { extraFlags = 0, refId = 1, nextRefId = 1 } = {},
  ) {
    const byteArray = Buffer.from(new Uint8Array(52))
    super({
      bytes: { start: 0, end: 0, byteArray },
      fileOffset: 0,
      dataView: new DataView(
        byteArray.buffer,
        byteArray.byteOffset,
        byteArray.byteLength,
      ),
    })
    this.tlen = tlen
    this.nextrefid = nextRefId
    this.refid = refId
    this._flags =
      (read1 ? 0x40 : 0x80) |
      (strand1 === 'R' ? 0x10 : 0) |
      (strand2 === 'R' ? 0x20 : 0) |
      extraFlags
  }

  override get flags() {
    return this._flags
  }

  override get template_length() {
    return this.tlen
  }

  override get next_refid() {
    return this.nextrefid
  }

  override get ref_id() {
    return this.refid
  }
}
