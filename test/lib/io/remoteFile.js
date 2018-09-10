const fetch = require('cross-fetch')
const BufferCache = require('./bufferCache')

class RemoteFile {
  constructor(source) {
    this.position = 0
    this.url = source
    this.cache = new BufferCache({
      fetch: (start, length) => this._fetch(start, length),
    })
  }

  async _fetch(position, length) {
    const headers = {}
    if (length < Infinity) {
      headers.range = `bytes=${position}-${position + length}`
    } else if (length === Infinity && position !== 0) {
      headers.range = `bytes=${position}-`
    }
    const response = await fetch(this.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      mode: 'cors',
    })
    if (
      (response.status === 200 && position === 0) ||
      response.status === 206
    ) {
      const nodeBuffer = Buffer.from(await response.arrayBuffer())

      // try to parse out the size of the remote file
      const sizeMatch = /\/(\d+)$/.exec(response.headers.map['content-range'])
      if (sizeMatch[1]) this._stat = { size: parseInt(sizeMatch[1], 10) }

      return nodeBuffer
    }
    throw new Error(`HTTP ${response.status} fetching ${this.url}`)
  }

  read(buffer, offset = 0, length = Infinity, position = 0) {
    let readPosition = position
    if (readPosition === null) {
      readPosition = this.position
      this.position += length
    }
    return this.cache.get(buffer, offset, length, position)
  }

  async readFile() {
    const response = await fetch(this.url, {
      method: 'GET',
      redirect: 'follow',
      mode: 'cors',
    })
    return Buffer.from(await response.arrayBuffer())
  }

  async stat() {
    if (!this._stat) {
      const buf = Buffer.allocUnsafe(10)
      await this.read(buf, 0, 10, 0)
      if (!this._stat)
        throw new Error(`unable to determine size of file at ${this.url}`)
    }
    return this._stat
  }
}

module.exports = RemoteFile
