const Long = require('long')
const { unzip } = require('@gmod/bgzf-filehandle')

const VirtualOffset = require('./virtualOffset')
const Chunk = require('./chunk')

const { longToNumber } = require('./util')

const CSI1_MAGIC = 21582659 // CSI\1
const CSI2_MAGIC = 38359875 // CSI\2

function lshift(num, bits) {
  return num * 2 ** bits
}
function rshift(num, bits) {
  return Math.floor(num / 2 ** bits)
}

/**
 * calculate the list of bins that may overlap with region [beg,end) (zero-based half-open)
 * @returns {Array[number]}
 */
function reg2bins(beg, end, minShift, depth, binLimit) {
  beg -= 1 // < convert to 1-based closed
  if (beg < 1) beg = 1
  if (end > 2 ** 50) end = 2 ** 34 // 17 GiB ought to be enough for anybody
  end -= 1
  let l = 0
  let t = 0
  let s = minShift + depth * 3
  const bins = []
  for (; l <= depth; s -= 3, t += lshift(1, l * 3), l += 1) {
    const b = t + rshift(beg, s)
    const e = t + rshift(end, s)
    if (e - b + bins.length > binLimit)
      throw new Error(
        `query ${beg}-${end} is too large for current binning scheme (shift ${minShift}, depth ${depth}), try a smaller query or a coarser index binning scheme`,
      )
    for (let i = b; i <= e; i += 1) bins.push(i)
  }
  return bins
}

class CSI {
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
    const idx = indexData.indices[refId]
    if (!idx) return -1
    const stats = indexData.indices[refId].stats
    if (stats) return stats.lineCount
    return -1
  }

  parseAuxData(bytes, offset, auxLength) {
    if (auxLength < 30) return {}

    const data = {}
    data.formatFlags = bytes.readInt32LE(offset)
    data.coordinateType =
      data.formatFlags & 0x10000 ? 'zero-based-half-open' : '1-based-closed'
    data.format = { 0: 'generic', 1: 'SAM', 2: 'VCF' }[data.formatFlags & 0xf]
    if (!data.format)
      throw new Error(`invalid Tabix preset format flags ${data.formatFlags}`)
    data.columnNumbers = {
      ref: bytes.readInt32LE(offset + 4),
      start: bytes.readInt32LE(offset + 8),
      end: bytes.readInt32LE(offset + 12),
    }
    data.metaValue = bytes.readInt32LE(offset + 16)
    data.metaChar = data.metaValue ? String.fromCharCode(data.metaValue) : ''
    data.skipLines = bytes.readInt32LE(offset + 20)
    const nameSectionLength = bytes.readInt32LE(offset + 24)

    Object.assign(
      data,
      this._parseNameBytes(
        bytes.slice(offset + 28, offset + 28 + nameSectionLength),
      ),
    )
    return data
  }

  _parseNameBytes(namesBytes) {
    let currRefId = 0
    let currNameStart = 0
    const refIdToName = []
    const refNameToId = {}
    for (let i = 0; i < namesBytes.length; i += 1) {
      if (!namesBytes[i]) {
        if (currNameStart < i) {
          let refName = namesBytes.toString('utf8', currNameStart, i)
          refName = this.renameRefSeq(refName)
          refIdToName[currRefId] = refName
          refNameToId[refName] = currRefId
        }
        currNameStart = i + 1
        currRefId += 1
      }
    }
    return { refNameToId, refIdToName }
  }

  // memoize
  // fetch and parse the index
  async parse() {
    const data = { csi: true, maxBlockSize: 1 << 16 }
    const bytes = await unzip(await this.filehandle.readFile())

    // check TBI magic numbers
    if (bytes.readUInt32LE(0) === CSI1_MAGIC) {
      data.csiVersion = 1
    } else if (bytes.readUInt32LE(0) === CSI2_MAGIC) {
      data.csiVersion = 2
    } else {
      throw new Error('Not a CSI file')
      // TODO: do we need to support big-endian CSI files?
    }

    data.minShift = bytes.readInt32LE(4)
    data.depth = bytes.readInt32LE(8)
    data.maxBinNumber = ((1 << ((data.depth + 1) * 3)) - 1) / 7
    const auxLength = bytes.readInt32LE(12)
    if (auxLength) {
      Object.assign(data, this.parseAuxData(bytes, 16, auxLength))
    }
    data.refCount = bytes.readInt32LE(16 + auxLength)

    // read the indexes for each reference sequence
    data.indices = new Array(data.refCount)
    let currOffset = 16 + auxLength + 4
    for (let i = 0; i < data.refCount; i += 1) {
      // the binning index
      const binCount = bytes.readInt32LE(currOffset)
      currOffset += 4
      const binIndex = {}
      let stats // < provided by parsing a pseudo-bin, if present
      for (let j = 0; j < binCount; j += 1) {
        const bin = bytes.readUInt32LE(currOffset)
        if (bin > data.maxBinNumber) {
          // this is a fake bin that actually has stats information
          // about the reference sequence in it
          stats = this.parsePseudoBin(bytes, currOffset + 4)
          currOffset += 4 + 8 + 4 + 16 + 16
        } else {
          const loffset = VirtualOffset.fromBytes(bytes, currOffset + 4)
          this._findFirstData(data, loffset)
          const chunkCount = bytes.readInt32LE(currOffset + 12)
          currOffset += 16
          const chunks = new Array(chunkCount)
          for (let k = 0; k < chunkCount; k += 1) {
            const u = VirtualOffset.fromBytes(bytes, currOffset)
            const v = VirtualOffset.fromBytes(bytes, currOffset + 8)
            currOffset += 16
            // this._findFirstData(data, u)
            chunks[k] = new Chunk(u, v, bin)
          }
          binIndex[bin] = chunks
        }
      }

      data.indices[i] = { binIndex, stats }
    }

    return data
  }

  parsePseudoBin(bytes, offset) {
    // const one = Long.fromBytesLE(bytes.slice(offset + 4, offset + 12), true)
    // const two = Long.fromBytesLE(bytes.slice(offset + 12, offset + 20), true)
    // const three = longToNumber(
    //   Long.fromBytesLE(bytes.slice(offset + 20, offset + 28), true),
    // )
    const lineCount = longToNumber(
      Long.fromBytesLE(bytes.slice(offset + 28, offset + 36), true),
    )
    return { lineCount }
  }

  async blocksForRange(refId, beg, end) {
    if (beg < 0) beg = 0

    const indexData = await this.parse()
    if (!indexData) return []
    const indexes = indexData.indices[refId]
    if (!indexes) return []

    const { binIndex } = indexes

    const bins = reg2bins(
      beg,
      end,
      indexData.minShift,
      indexData.depth,
      indexData.maxBinNumber,
    )

    let l
    let numOffsets = 0
    for (let i = 0; i < bins.length; i += 1) {
      if (binIndex[bins[i]]) numOffsets += binIndex[bins[i]].length
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
tinyMemoize(CSI, 'parse')

module.exports = CSI
