const { promisify } = require('es6-promisify')

// don't load fs native module if running in webpacked code
const fs = typeof __webpack_require__ !== 'function' ? require('fs') : null // eslint-disable-line camelcase

const fsOpen = fs && promisify(fs.open)
const fsRead = fs && promisify(fs.read)
const fsFStat = fs && promisify(fs.fstat)
const fsReadFile = fs && promisify(fs.readFile)

class LocalFile {
  constructor(source) {
    this.position = 0
    this.filename = source
    this.fd = fsOpen(this.filename, 'r')
  }

  async read(buffer, offset = 0, length, position) {
    let readPosition = position
    if (readPosition === null) {
      readPosition = this.position
      this.position += length
    }
    const ret = await fsRead(await this.fd, buffer, offset, length, position)
    if (typeof ret === 'object') return ret.bytesRead
    return ret
  }

  async readFile() {
    return fsReadFile(this.filename)
  }

  async stat() {
    if (!this._stat) {
      this._stat = await fsFStat(await this.fd)
    }
    return this._stat
  }
}

module.exports = LocalFile
