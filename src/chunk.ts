import { Offset } from './virtualOffset.ts'

// little class representing a chunk in the index
export default class Chunk {
  public buffer?: Uint8Array<ArrayBuffer>

  constructor(
    public minv: Offset,
    public maxv: Offset,
    public bin: number,
    public _fetchedSize?: number,
  ) {}

  toUniqueString() {
    return `${this.minv.toString()}..${this.maxv.toString()} (bin ${
      this.bin
    }, fetchedSize ${this.fetchedSize()})`
  }

  toString() {
    return this.toUniqueString()
  }

  compareTo(b: Chunk) {
    return (
      this.minv.compareTo(b.minv) ||
      this.maxv.compareTo(b.maxv) ||
      this.bin - b.bin
    )
  }

  fetchedSize() {
    if (this._fetchedSize !== undefined) {
      return this._fetchedSize
    }
    return this.maxv.blockPosition + (1 << 16) - this.minv.blockPosition
  }
}
