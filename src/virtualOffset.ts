export default class VirtualOffset {
  public blockPosition: number
  public dataPosition: number
  constructor(blockPosition: number, dataPosition: number) {
    this.blockPosition = blockPosition // < offset of the compressed data block
    this.dataPosition = dataPosition // < offset into the uncompressed data
  }

  toString() {
    return `${this.blockPosition}:${this.dataPosition}`
  }

  compareTo(b: VirtualOffset) {
    return (
      this.blockPosition - b.blockPosition || this.dataPosition - b.dataPosition
    )
  }
}
export function fromBytes(bytes: Uint8Array, offset = 0, bigendian = false) {
  if (bigendian) {
    throw new Error('big-endian virtual file offsets not implemented')
  }

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
