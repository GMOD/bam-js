// @ts-nocheck
import { Buffer } from 'buffer'

import Record from '../src/record.ts'

export default class FakeRecord extends Record {
  constructor(read1, strand1, strand2, tlen) {
    super({
      bytes: {
        start: 0,
        byteArray: Buffer.from([
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
        ]),
      },
    })
    this.tlen = tlen
    this.nextrefid = 1
    this.refid = 1
    this._flags =
      (read1 ? 0x40 : 0x80) |
      (strand1 === 'R' ? 0x10 : 0) |
      (strand2 === 'R' ? 0x20 : 0)
  }

  get flags() {
    return this._flags
  }

  get template_length() {
    return this.tlen
  }

  get next_refid() {
    return this.nextrefid
  }

  get ref_id() {
    return this.refid
  }
}
