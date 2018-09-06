const { unzip } = require('@gmod/bgzf-filehandle')
const { CSI } = require('@gmod/tabix')
const LocalFile = require('./localFile')

class BamFile {
  /**
   * @param {object} args
   * @param {string} [args.bamPath]
   * @param {FileHandle} [args.bamFilehandle]
   * @param {string} [args.baiPath]
   * @param {FileHandle} [args.baiFilehandle]
   */
  constructor({ bamFilehandle, bamPath, baiPath, baiFilehandle, csiPath, csiFilehandle }) {
    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    }
    if(csiFilehandle) {
      this.index = csiFilehandle
    } else if(csiPath) {
      this.index = new LocalFile(csiPath)
    } else if(baiFilehandle) {
      this.index = baiFilehandle
    } else if (baiPath) {
      this.index = new LocalFile(baiPath)
    } else {
      this.index = new LocalFile(bamPath + '.bai')
    }
  }

  async getHeader() {
    const data = await this.data.read(
        0,
        thisB.index.minAlignmentVO ? thisB.index.minAlignmentVO.block + 65535 : undefined)

    var uncba;
    try {
        uncba = new Uint8Array( unzip(r) );
    } catch(e) {
        throw new Error( "Could not uncompress BAM data. Is it compressed correctly?" );
    }

    if( readInt(uncba, 0) != BAM_MAGIC)
        throw new Error('Not a BAM file');

    var headLen = readInt(uncba, 4);

    thisB._readRefSeqs( headLen+8, 65536*4, successCallback, failCallback );
  }
}

module.exports = BamFile
