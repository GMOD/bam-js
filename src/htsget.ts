import { BaseOpts } from './indexFile'
import BamFile, { BamOpts } from './bamFile'
import fetch from 'cross-fetch'

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
    console.log(url)
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
    console.log(data)
  }

  async getHeader(opts: BaseOpts = {}) {
    console.log('gere')
    const url = `${this.baseUrl}/${this.trackId}?format=BAM&referenceName=1`
    console.log(url)
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
    const header = data.htsget.urls[0]
    const buf = header.url.startsWith('data:')
      ? Buffer.from(header.url.split(',')[1], 'base64')
      : undefined
    return 1 as any
  }
}
