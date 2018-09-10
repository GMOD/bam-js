const LRU = require('lru-cache')

class BufferCache {
  constructor({ fetch, size = 10000000, chunkSize = 32768 }) {
    if (!fetch) throw new Error('fetch function required')
    this.fetch = fetch
    this.chunkSize = chunkSize
    this.lruCache = LRU({ max: Math.floor(size / chunkSize) })
  }
  async get(outputBuffer, offset, length, position) {
    if (outputBuffer.length < offset + length)
      throw new Error('output buffer not big enough for request')

    // calculate the list of chunks involved in this fetch
    const firstChunk = Math.floor(position / this.chunkSize)
    const lastChunk = Math.floor((position + length) / this.chunkSize)

    // fetch them all as necessary
    const fetches = new Array(lastChunk - firstChunk + 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      fetches[chunk - firstChunk] = this._getChunk(chunk).then(data => ({
        data,
        chunkNumber: chunk,
      }))
    }

    // stitch together the response buffer using them
    const chunks = await Promise.all(fetches)
    const chunksOffset = position - chunks[0].chunkNumber * this.chunkSize
    chunks.forEach(({ data, chunkNumber }) => {
      const chunkPositionStart = chunkNumber * this.chunkSize
      let copyStart = 0
      let copyEnd = this.chunkSize
      let copyOffset =
        offset + (chunkNumber - firstChunk) * this.chunkSize - chunksOffset

      if (chunkNumber === firstChunk) {
        copyOffset = offset
        copyStart = chunksOffset
      }
      if (chunkNumber === lastChunk) {
        copyEnd = position + length - chunkPositionStart
      }

      data.copy(outputBuffer, copyOffset, copyStart, copyEnd)
    })
  }

  _getChunk(chunkNumber) {
    const cachedPromise = this.lruCache.get(chunkNumber)
    if (cachedPromise) return cachedPromise

    const freshPromise = this.fetch(
      chunkNumber * this.chunkSize,
      this.chunkSize,
    )
    this.lruCache.set(chunkNumber, freshPromise)
    return freshPromise
  }
}
module.exports = BufferCache
