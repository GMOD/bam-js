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
    this.read1 = read1
    this.read2 = !read1
    this.strand1 = strand1 === 'R'
    this.strand2 = strand2 === 'R'
    this.tlen = tlen
    this.nextrefid = 1
    this.refid = 1
  }

  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get flags() {
    return 0
  }

  isRead1() {
    return this.read1
  }

  isRead2() {
    return this.read2
  }

  isMateReverseComplemented() {
    return this.strand2
  }

  isReverseComplemented() {
    return this.strand1
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
