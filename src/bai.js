const VirtualOffset = require('./virtualOffset')
const Chunk = require('./chunk')

const BAI_MAGIC = 21578050 // BAI\1

/**
 * calculate the list of bins that may overlap with region [beg,end) (zero-based half-open)
 * @returns {Array[number]}
 */
function reg2bins(beg, end) {
  const list = [0]
  end -= 1
  for (let k = 1 + (beg >> 26); k <= 1 + (end >> 26); k += 1) list.push(k)
  for (let k = 9 + (beg >> 23); k <= 9 + (end >> 23); k += 1) list.push(k)
  for (let k = 73 + (beg >> 20); k <= 73 + (end >> 20); k += 1) list.push(k)
  for (let k = 585 + (beg >> 17); k <= 585 + (end >> 17); k += 1) list.push(k)
  for (let k = 4681 + (beg >> 14); k <= 4681 + (end >> 14); k += 1) list.push(k)
  return list
}

class BAI {
  /**
   * @param {filehandle} filehandle
   * @param {function} [renameRefSeqs]
   */
  constructor({ filehandle, renameRefSeqs = n => n }) {
    this.filehandle = filehandle
    this.renameRefSeq = renameRefSeqs
  }

  _findFirstData(data, virtualOffset) {
    const currentFdl = data.firstDataLine
    if (currentFdl) {
      data.firstDataLine =
        currentFdl.compareTo(virtualOffset) > 0 ? virtualOffset : currentFdl
    } else {
      data.firstDataLine = virtualOffset
    }
  }

  async lineCount(refId) {
    const indexData = await this.parse()
    if (!indexData) return -1
    const indexes = indexData.indices[refId]
    if (!indexes) return -1
    const depth = 5
    const binLimit = ((1 << ((depth + 1) * 3)) - 1) / 7
    const ret = indexes.binIndex[binLimit + 1]
    return ret ? ret[ret.length - 1].minv.dataPosition : -1
  }

  // memoize
  // fetch and parse the index
  async parse() {
    const data = { bai: true, maxBlockSize: 1 << 16 }
    const bytes = await this.filehandle.readFile()

    // check BAI magic numbers
    if (bytes.readUInt32LE(0) !== BAI_MAGIC) {
      throw new Error('Not a BAI file')
    }

    data.refCount = bytes.readInt32LE(4)

    // read the indexes for each reference sequence
    data.indices = new Array(data.refCount)
    let currOffset = 8
    for (let i = 0; i < data.refCount; i += 1) {
      // the binning index
      const binCount = bytes.readInt32LE(currOffset)

      currOffset += 4
      const binIndex = {}
      for (let j = 0; j < binCount; j += 1) {
        const bin = bytes.readUInt32LE(currOffset)
        const chunkCount = bytes.readInt32LE(currOffset + 4)
        currOffset += 8
        const chunks = new Array(chunkCount)
        for (let k = 0; k < chunkCount; k += 1) {
          const u = VirtualOffset.fromBytes(bytes, currOffset)
          const v = VirtualOffset.fromBytes(bytes, currOffset + 8)
          currOffset += 16
          this._findFirstData(data, u)
          chunks[k] = new Chunk(u, v, bin)
        }
        binIndex[bin] = chunks
      }

      const nintv = bytes.readInt32LE(currOffset)
      currOffset += 4
      // as we're going through the linear index, figure out
      // the smallest virtual offset in the indexes, which
      // tells us where the BAM header ends
      if (nintv) {
        this._findFirstData(bytes, VirtualOffset.fromBytes(bytes, currOffset))
      }

      currOffset += nintv * 8

      data.indices[i] = { binIndex }
    }

    return data
  }

  async blocksForRange(refId, beg, end) {
    if (beg < 0) beg = 0

    const indexData = await this.parse()
    if (!indexData) return []
    const indexes = indexData.indices[refId]
    if (!indexes) return []

    const { binIndex } = indexes

    const bins = reg2bins(beg, end)

    let l
    let numOffsets = 0
    for (let i = 0; i < bins.length; i += 1) {
      if (binIndex[bins[i]]) {
        numOffsets += binIndex[bins[i]].length
      }
    }

    if (numOffsets === 0) return []

    let off = []
    numOffsets = 0
    for (let i = 0; i < bins.length; i += 1) {
      const chunks = binIndex[bins[i]]
      if (chunks)
        for (let j = 0; j < chunks.length; j += 1) {
          off[numOffsets] = new Chunk(
            chunks[j].minv,
            chunks[j].maxv,
            chunks[j].bin,
          )
          numOffsets += 1
        }
    }

    if (!off.length) return []

    off = off.sort((a, b) => a.compareTo(b))

    // resolve completely contained adjacent blocks
    l = 0
    for (let i = 1; i < numOffsets; i += 1) {
      if (off[l].maxv.compareTo(off[i].maxv) < 0) {
        l += 1
        off[l].minv = off[i].minv
        off[l].maxv = off[i].maxv
      }
    }
    numOffsets = l + 1

    // resolve overlaps between adjacent blocks; this may happen due to the merge in indexing
    for (let i = 1; i < numOffsets; i += 1)
      if (off[i - 1].maxv.compareTo(off[i].minv) >= 0)
        off[i - 1].maxv = off[i].minv
    // merge adjacent blocks
    l = 0
    for (let i = 1; i < numOffsets; i += 1) {
      if (off[l].maxv.blockPosition === off[i].minv.blockPosition)
        off[l].maxv = off[i].maxv
      else {
        l += 1
        off[l].minv = off[i].minv
        off[l].maxv = off[i].maxv
      }
    }
    numOffsets = l + 1

    return off.slice(0, numOffsets)
  }

  /**
   * @param {number} seqId
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasRefSeq(seqId) {
    return !!(await this.parse()).indices[seqId]
  }
}

// this is the stupidest possible memoization, ignores arguments.
function tinyMemoize(_class, methodName) {
  const method = _class.prototype[methodName]
  if (!method)
    throw new Error(`no method ${methodName} found in class ${_class.name}`)
  const memoAttrName = `_memo_${methodName}`
  _class.prototype[methodName] = function _tinyMemoized() {
    if (!(memoAttrName in this)) this[memoAttrName] = method.call(this)
    return this[memoAttrName]
  }
}
// memoize index.parse()
tinyMemoize(BAI, 'parse')

module.exports = BAI
