export const TWO_PWR_16_DBL = 1 << 16
export const TWO_PWR_32_DBL = TWO_PWR_16_DBL * TWO_PWR_16_DBL

export function longFromBytesToUnsigned(source: Uint8Array, i = 0) {
  const low =
    source[i]! |
    (source[i + 1]! << 8) |
    (source[i + 2]! << 16) |
    (source[i + 3]! << 24)
  const high =
    source[i + 4]! |
    (source[i + 5]! << 8) |
    (source[i + 6]! << 16) |
    (source[i + 7]! << 24)
  return (high >>> 0) * TWO_PWR_32_DBL + (low >>> 0)
}
