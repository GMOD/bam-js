import { BaseOpts } from './indexFile'
import BamFile, { BamOpts, BAM_MAGIC } from './bamFile'
import fetch from 'cross-fetch'
import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import { parseHeaderText } from './sam'

interface HeaderLine {
  tag: string
  value: string
}

export default class Htsget extends BamFile {
  // e.g. 'https://htsget.wtsi-npg-test.co.uk:9090/npg_ranger/ga4gh/sample/NA12878?referenceName=22&start=16101000&end=16102000&format=BAM'
  private baseUrl: string

  private trackId: string

  constructor(args: { trackId: string; baseUrl: string }) {
    // just override bam defaults
    super({ bamFilehandle: '?', baiFilehandle: '?' })
    this.baseUrl = args.baseUrl
    this.trackId = args.trackId
  }

  async *streamRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts: BamOpts = { viewAsPairs: false, pairAcrossChr: false, maxInsertSize: 200000 },
  ) {
    const url = `${this.baseUrl}/${this.trackId}?referenceName=${chr}&start=${min}&end=${max}&format=BAM`
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
  }

  async getHeader(opts: BaseOpts = {}) {
    const url = `${this.baseUrl}/${this.trackId}?format=BAM&referenceName=1`
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
    const header = data.htsget.urls[0]
    const buf = header.url.startsWith('data:')
      ? Buffer.from(header.url.split(',')[1], 'base64')
      : undefined

    const uncba = await unzip(buf)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = uncba.readInt32LE(4)

    const headerText = uncba.toString('utf8', 8, 8 + headLen)
    //const { chrToIndex, indexToChr } = await this._readRefSeqs(headLen + 8, 65535, opts)
    // this.chrToIndex = chrToIndex
    // this.indexToChr = indexToChr
    //
    const samHeader = parseHeaderText(headerText)

    // use the @SQ lines in the header to figure out the
    // mapping between ref ref ID numbers and names
    const idToName: string[] = []
    const nameToId: Record<string, number> = {}
    const sqLines = samHeader.filter((l: { tag: string }) => l.tag === 'SQ')
    sqLines.forEach((sqLine: { data: HeaderLine[] }, refId: number) => {
      sqLine.data.forEach((item: HeaderLine) => {
        if (item.tag === 'SN') {
          // this is the ref name
          const refName = item.value
          nameToId[refName] = refId
          idToName[refId] = refName
        }
      })
    })
    this.chrToIndex = nameToId
    this.indexToChr = idToName
    return samHeader
  }
}
