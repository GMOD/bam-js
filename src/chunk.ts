import VirtualOffset from './virtualOffset'

// little class representing a chunk in the index
export default class Chunk {
  public buffer?: Buffer

  constructor(
    public minv: VirtualOffset,
    public maxv: VirtualOffset,
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
