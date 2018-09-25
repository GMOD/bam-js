module.exports = {
  longToNumber(long) {
    if (
      long.greaterThan(Number.MAX_SAFE_INTEGER) ||
      long.lessThan(Number.MIN_SAFE_INTEGER)
    ) {
      throw new Error('integer overflow')
    }
    return long.toNumber()
  },
}
