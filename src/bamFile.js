const LocalFile = require('./localFile')

class BamFile {
  /**
   * @param {object} args
   * @param {string} [args.path]
   * @param {string} [args.url]
   * @param {FileHandle} [args.filehandle]
   */
  constructor({ bamFilehandle, bamPath }) {
    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    }
  }
}

module.exports = BamFile
