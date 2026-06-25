import type { Offset } from './virtualOffset.ts'

// little class representing a chunk in the index
export default class Chunk {
  public minv: Offset
  public maxv: Offset
  public bin: number
  // Absolute byte offset where the fetch for this chunk ends. The compressed
  // size of the final BGZF block (the one at maxv.blockPosition) is unknown
  // from the index, so this defaults to a full max-size block past maxv. It can
  // be tightened to the next known block boundary via clampChunkEnds.
  public endPosition: number

  constructor(
    minv: Offset,
    maxv: Offset,
    bin: number,
    endPosition = maxv.blockPosition + (1 << 16),
  ) {
    this.minv = minv
    this.maxv = maxv
    this.bin = bin
    this.endPosition = endPosition
  }

  toString() {
    return `${this.minv.toString()}..${this.maxv.toString()} (bin ${
      this.bin
    }, fetchedSize ${this.fetchedSize()})`
  }

  compareTo(b: Chunk) {
    return (
      this.minv.compareTo(b.minv) ||
      this.maxv.compareTo(b.maxv) ||
      this.bin - b.bin
    )
  }

  fetchedSize() {
    return this.endPosition - this.minv.blockPosition
  }
}
