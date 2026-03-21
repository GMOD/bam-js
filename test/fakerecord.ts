import { Buffer } from 'buffer'

import Record from '../src/record.ts'

export default class FakeRecord extends Record {
  private tlen: number
  private nextrefid: number
  private refid: number
  private _flags: number

  constructor(read1: boolean, strand1: string, strand2: string, tlen: number) {
    super({
      bytes: {
        start: 0,
        end: 0,
        byteArray: Buffer.from([
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
        ]),
      },
      fileOffset: 0,
    })
    this.tlen = tlen
    this.nextrefid = 1
    this.refid = 1
    this._flags =
      (read1 ? 0x40 : 0x80) |
      (strand1 === 'R' ? 0x10 : 0) |
      (strand2 === 'R' ? 0x20 : 0)
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
