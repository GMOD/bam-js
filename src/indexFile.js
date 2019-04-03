import AbortablePromiseCache from 'abortable-promise-cache'
import QuickLRU from 'quick-lru'

class IndexFile {
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

  async parse(abortSignal) {
    if (!this._parseCache)
      this._parseCache = new AbortablePromiseCache({
        cache: new QuickLRU({ maxSize: 1 }),
        fill: this._parse.bind(this),
      })
    return this._parseCache.get('index', null, abortSignal)
  }

  /**
   * @param {number} seqId
   * @param {AbortSignal} [abortSignal]
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasRefSeq(seqId, abortSignal) {
    return !!((await this.parse(abortSignal)).indices[seqId] || {}).binIndex
  }
}

module.exports = IndexFile
