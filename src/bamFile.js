const { unzip } = require('@gmod/bgzf-filehandle')
const { CSI } = require('@gmod/tabix')
const BAI = require('./bai')
const LocalFile = require('./localFile')

const BAM_MAGIC = 21840194

class BamFile {
  /**
   * @param {object} args
   * @param {string} [args.bamPath]
   * @param {FileHandle} [args.bamFilehandle]
   * @param {string} [args.baiPath]
   * @param {FileHandle} [args.baiFilehandle]
   */
  constructor({
    bamFilehandle,
    bamPath,
    baiPath,
    baiFilehandle,
    csiPath,
    csiFilehandle,
  }) {
    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    }

    if (csiFilehandle) {
      this.index = new CSI({ filehandle: csiFilehandle })
    } else if (csiPath) {
      this.index = new CSI({ filehandle: new LocalFile(csiPath) })
    } else if (baiFilehandle) {
      this.index = new BAI({ filehandle: baiFilehandle })
    } else if (baiPath) {
      this.index = new BAI({ filehandle: new LocalFile(baiPath) })
    } else {
      this.index = new BAI({ filehandle: new LocalFile(`${bamPath}.bai`) })
    }
  }

  async getHeader() {
    const indexData = await this.index.parse()
    const ret = indexData.firstDataLine
      ? indexData.firstDataLine.blockPosition + 65535
      : undefined

    const buf = Buffer.allocUnsafe(ret)
    await this.bam.read(buf, 0, ret)

    const uncba = await unzip(buf)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) throw new Error('Not a BAM file')
    const headLen = uncba.readInt32LE(4)

    return this._readRefSeqs(headLen + 8, 65535)
  }

  async _readRefSeqs(start, refSeqBytes) {
    const buf = Buffer.allocUnsafe(refSeqBytes)
    await this.bam.read(buf, 0, refSeqBytes, 0)

    const uncba = await unzip(buf)
    const nRef = uncba.readInt32LE(start)
    let p = start + 4
    this.chrToIndex = {}
    this.indexToChr = []
    for (let i = 0; i < nRef; i += 1) {
      const lName = uncba.readInt32LE(p)
      let name = ''
      for (let j = 0; j < lName - 1; j += 1) {
        name += String.fromCharCode(uncba[p + 4 + j])
      }

      const lRef = uncba.readInt32LE(p + lName + 4)
      this.chrToIndex[name] = i
      this.indexToChr.push({ name, length: lRef })

      p = p + 8 + lName
      if (p > uncba.length) {
        // we've gotten to the end of the data without
        // finishing reading the ref seqs, need to fetch a
        // bigger chunk and try again.  :-(
        refSeqBytes *= 2
        console.warn(
          `BAM header is very big.  Re-fetching ${refSeqBytes} bytes.`,
        )
        return this._readRefSeqs(start, refSeqBytes)
      }
    }
    return true
  }
}

module.exports = BamFile
