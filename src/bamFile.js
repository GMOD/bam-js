const { unzip } = require('@gmod/bgzf-filehandle')
const { CSI } = require('@gmod/tabix')
const BAI = require('./bai')
const LocalFile = require('./localFile')
const LRU = require('lru-cache')

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
    this.options = {
      cacheSize: args.cacheSize !== undefined ? args.cacheSize : 20000,
    }

    // cache of features in a slice, keyed by the
    // slice offset. caches all of the features in a slice, or none.
    // the cache is actually used by the slice object, it's just
    // kept here at the level of the file
    this.featureCache = LRU({
      max: this.options.cacheSize,
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
    return true
  }

  fetch(chr, min, max, featCallback, endCallback, errorCallback) {
    // todo regularize refseq names
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    let chunks
    if (!(chrId >= 0)) {
      chunks = []
    } else {
      chunks = this.index.blocksForRange(chrId, min, max, true)
      if (!chunks) {
        errorCallback(new Errors.Fatal('Error in index fetch'))
      }
    }

    // toString function is used by the cache for making cache keys
    chunks.toString = function() {
      return this.join(', ')
    }

    try {
      this._fetchChunkFeatures(
        chunks,
        chrId,
        min,
        max,
        featCallback,
        endCallback,
        errorCallback,
      )
    } catch (e) {
      errorCallback(e)
    }
  }

  _fetchChunkFeatures(
    chunks,
    chrId,
    min,
    max,
    featCallback,
    endCallback,
    errorCallback,
  ) {
    const thisB = this

    if (!chunks.length) {
      endCallback()
      return
    }

    let chunksProcessed = 0

    // check the chunks for any that are over the size limit.  if
    // any are, don't fetch any of them
    for (let i = 0; i < chunks.length; i++) {
      const size = chunks[i].fetchedSize()
      if (size > this.chunkSizeLimit) {
        errorCallback(
          new Errors.DataOverflow(
            `Too many BAM features. BAM chunk size ${Util.commifyNumber(
              size,
            )} bytes exceeds chunkSizeLimit of ${Util.commifyNumber(
              this.chunkSizeLimit,
            )}.`,
          ),
        )
        return
      }
    }

    let haveError
    let pastStart
    array.forEach(chunks, c => {
      this.featureCache.get(c, (f, e) => {
        if (e && !haveError) errorCallback(e)
        if ((haveError = haveError || e)) {
          return
        }

        for (let i = 0; i < f.length; i++) {
          const feature = f[i]
          if (feature._refID == chrId) {
            // on the right ref seq
            if (feature.get('start') > max)
              // past end of range, can stop iterating
              break
            else if (feature.get('end') >= min)
              // must be in range
              featCallback(feature)
          }
        }
        if (++chunksProcessed == chunks.length) {
          endCallback()
        }
      })
    })
  }

  async _readChunk(chunk, callback) {
    const features = []
    // console.log('chunk '+chunk+' size ',Util.humanReadableNumber(size));
    const bufsize = chunk.fetchedSize()
    const buf = Buffer.allocUnsafe(bufsize)
    await this.data.read(buf, chunk.minv.block, bufsize)
    const data = await unzip(buf)
    this.readBamFeatures(
      new Uint8Array(data),
      chunk.minv.offset,
      features,
      callback,
    )
  }

  readBamFeatures(ba, blockStart, sink, callback) {
    const that = this
    let featureCount = 0

    const maxFeaturesWithoutYielding = 300

    while (true) {
      if (blockStart >= ba.length) {
        // if we're done, call the callback and return
        callback(sink)
        return
      } else if (featureCount <= maxFeaturesWithoutYielding) {
        // if we've read no more than 200 features this cycle, read another one
        const blockSize = readInt(ba, blockStart)
        const blockEnd = blockStart + 4 + blockSize - 1

        // only try to read the feature if we have all the bytes for it
        if (blockEnd < ba.length) {
          const feature = new BAMFeature({
            store: this.store,
            file: this,
            bytes: { byteArray: ba, start: blockStart, end: blockEnd },
          })
          sink.push(feature)
          featureCount++
        }

        blockStart = blockEnd + 1
      } else {
        // if we're not done but we've read a good chunk of
        // features, put the rest of our work into a timeout to continue
        // later, avoiding blocking any UI stuff that's going on
        window.setTimeout(() => {
          that.readBamFeatures(ba, blockStart, sink, callback)
        }, 1)
        return
      }
    }
  }
}

module.exports = BamFile
