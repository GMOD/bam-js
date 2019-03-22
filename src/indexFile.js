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
    if (!this._parseCache) {
      this._parseCache = this._parse(abortSignal)
      this._parseCache.catch(() => {
        if (abortSignal && abortSignal.aborted) delete this._parseCache
      })
      return this._parseCache
    }
    return this._parseCache.catch(e => {
      if (e.code === 'ERR_ABORTED' || e.name === 'AbortError') {
        return this.parse(abortSignal)
      }
      throw e
    })
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
