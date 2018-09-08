const { unzip } = require('@gmod/bgzf-filehandle')
const { CSI } = require('@gmod/tabix')
const LRU = require('lru-cache')

const BAI = require('./bai')
const LocalFile = require('./localFile')
const BAMFeature = require('./record')

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
    cacheSize,
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

    this.featureCache = LRU({
      max: cacheSize,
      length: featureArray => featureArray.length,
    })
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

    this.header = uncba.toString('utf8', 8, 8 + headLen)
    // this.header = ''
    // for (let j = 0; j < headLen; j += 1) {
    //   this.header += String.fromCharCode(uncba[4 + j])
    // }
    return this._readRefSeqs(headLen + 8, 65535)
  }

  // the full length of the refseq block is not given in advance so this grabs a chunk and
  // doubles it if all refseqs haven't been processed
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
      const name = uncba.toString('utf8', p + 4, p + 4 + lName - 1)
      const lRef = uncba.readInt32LE(p + lName + 4)
      this.chrToIndex[name] = i
      this.indexToChr.push({ name, length: lRef })

      p = p + 8 + lName
      if (p > uncba.length) {
        console.warn(
          `BAM header is very big.  Re-fetching ${refSeqBytes} bytes.`,
        )
        return this._readRefSeqs(start, refSeqBytes * 2)
      }
    }
    this.index.refNameToId = this.chrToIndex
    return true
  }

  async getRecordsForRange(chr, min, max) {
    // todo regularize refseq names
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    let chunks
    if (!(chrId >= 0)) {
      chunks = []
    } else {
      chunks = await this.index.blocksForRange(chrId, min, max)
      if (!chunks) {
        throw new Error('Error in index fetch')
      }
    }

    // toString function is used by the cache for making cache keys
    chunks.toString = function() {
      return this.join(', ')
    }

    return this._fetchChunkFeatures(chunks, chrId, min, max)
  }

  _fetchChunkFeatures(chunks, chrId, min, max) {
    if (!chunks.length) {
      return
    }

    // check the chunks for any that are over the size limit.  if
    // any are, don't fetch any of them
    for (let i = 0; i < chunks.length; i += 1) {
      const size = chunks[i].fetchedSize()
      if (size > this.chunkSizeLimit) {
        throw new Error(
          `Too many BAM features. BAM chunk size ${size} bytes exceeds chunkSizeLimit of ${
            this.chunkSizeLimit
          }`,
        )
      }
    }

    const records = []
    const recordPromises = []
    chunks.forEach(c => {
      let recordPromise = this.featureCache.get(c)
      if (!recordPromise) {
        recordPromise = this._readChunk(c)
        recordPromises.push(recordPromise)
        this.featureCache.set(c, recordPromise)
      }
      recordPromise.then(
        f => {
          for (let i = 0; i < f.length; i += 1) {
            const feature = f[i]
            if (feature._refID === chrId) {
              // on the right ref seq
              if (feature.get('start') > max)
                // past end of range, can stop iterating
                break
              else if (feature.get('end') >= min)
                // must be in range
                records.push(feature)
            }
          }
        },
        e => {
          console.error(e)
        },
      )
    })
    return Promise.all(recordPromises).then(() => records)
  }

  async _readChunk(chunk) {
    const bufsize = chunk.fetchedSize()
    const buf = Buffer.allocUnsafe(bufsize)
    await this.bam.read(buf, 0, bufsize, chunk.minv.blockPosition)
    const data = await unzip(buf)
    return this.readBamFeatures(data, chunk.minv.dataPosition)
  }

  readBamFeatures(ba, blockStart) {
    const sink = []

    while (blockStart < ba.length) {
      const blockSize = ba.readInt32LE(blockStart)
      const blockEnd = blockStart + 4 + blockSize - 1

      // only try to read the feature if we have all the bytes for it
      if (blockEnd < ba.length) {
        const feature = new BAMFeature({
          bytes: { byteArray: ba, start: blockStart, end: blockEnd },
        })
        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
  }
}

module.exports = BamFile
