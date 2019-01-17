import Record from '../src/record'

class FakeRecord extends Record {
  constructor(read1, strand1, strand2, tlen) {
    super({
      bytes: {
        start: 0,
        byteArray: Buffer.from([
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ]),
      },
    })
    this.read1 = read1
    this.read2 = !read1
    this.strand1 = strand1 === 'R'
    this.strand2 = strand2 === 'R'
    this.tlen = tlen
    this._refID = 1
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

  template_length() {
    return this.tlen
  }

  _next_refid() {
    return 1
  }
}

module.exports = FakeRecord
