// little class representing a chunk in the index
class Chunk {
  /**
   * @param {VirtualOffset} minv
   * @param {VirtualOffset} maxv
   * @param {number} bin
   * @param {number} [fetchedSize]
   */
  constructor(minv, maxv, bin, fetchedSize) {
    this.minv = minv
    this.maxv = maxv
    this.bin = bin
    this._fetchedSize = fetchedSize
  }

  toUniqueString() {
    return `${this.minv}..${this.maxv} (bin ${
      this.bin
    }, fetchedSize ${this.fetchedSize()})`
  }

  toString() {
    return this.toUniqueString()
  }

  compareTo(b) {
    return (
      this.minv.compareTo(b.minv) ||
      this.maxv.compareTo(b.maxv) ||
      this.bin - b.bin
    )
  }

  fetchedSize() {
    if (this._fetchedSize !== undefined) return this._fetchedSize
    return this.maxv.blockPosition + (1 << 16) - this.minv.blockPosition
  }
}

module.exports = Chunk
