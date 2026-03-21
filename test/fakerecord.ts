import Record from '../src/record'

export default class FakeRecord extends Record {
  private read1: boolean
  private read2: boolean
  private strand1: boolean
  private strand2: boolean
  private tlen: number

  constructor(read1: boolean, strand1: string, strand2: string, tlen: number) {
    super({
      bytes: {
        start: 0,
        end: 22,
        byteArray: Buffer.from([
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      },
      fileOffset: 0,
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
