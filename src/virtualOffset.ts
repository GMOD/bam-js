/**
 * The two coordinates a virtual offset packs, without the `blockPos:dataPos`
 * string form. What every consumer that only compares positions needs — the
 * BAI linear index stores these as raw numbers and materializes no object.
 */
export interface OffsetCoords {
  blockPosition: number
  dataPosition: number
}

export interface Offset extends OffsetCoords {
  toString(): string
}

export class VirtualOffset {
  public blockPosition: number
  public dataPosition: number
  constructor(blockPosition: number, dataPosition: number) {
    this.blockPosition = blockPosition // < offset of the compressed data block
    this.dataPosition = dataPosition // < offset into the uncompressed data
  }

  toString() {
    return `${this.blockPosition}:${this.dataPosition}`
  }
}
export function fromBytes(bytes: Uint8Array, offset = 0) {
  return new VirtualOffset(
    bytes[offset + 7]! * 0x10000000000 +
      bytes[offset + 6]! * 0x100000000 +
      bytes[offset + 5]! * 0x1000000 +
      bytes[offset + 4]! * 0x10000 +
      bytes[offset + 3]! * 0x100 +
      bytes[offset + 2]!,
    (bytes[offset + 1]! << 8) | bytes[offset]!,
  )
}
