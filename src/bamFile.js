const LocalFile = require('./localFile')

class BamFile {
  /**
   * @param {object} args
   * @param {string} [args.bamPath]
   * @param {FileHandle} [args.bamFilehandle]
   * @param {string} [args.baiPath]
   * @param {FileHandle} [args.baiFilehandle]
   */
  constructor({ bamFilehandle, bamPath, baiPath, baiFilehandle }) {
    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    }
    if(baiFilehandle) {
      this.bai = baiFilehandle
    } else if (baiPath) {
      this.bai = new LocalFile(baiPath)
    } else {
      this.bai = new LocalFile(bamPath + '.bai')
    }
  }
}

module.exports = BamFile
