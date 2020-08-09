import { BaseOpts } from './indexFile'
import BamFile, { BamOpts, BAM_MAGIC } from './bamFile'
import fetch from 'cross-fetch'
import { unzip } from '@gmod/bgzf-filehandle'
import { parseHeaderText } from './sam'
import parseRange from 'range-parser'

interface HeaderLine {
  tag: string
  value: string
}

function concat(arr, opts) {
  return arr.reduce(async (buf: Promise<Buffer>, chunk: any) => {
    let dat
    const { url, headers } = chunk
    if (url.startsWith('data:')) {
      dat = await unzip(Buffer.from(url.split(',')[1], 'base64'))
    } else {
      const res = await fetch(url, { ...opts, headers })
      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      dat = await unzip(buffer, url)
    }
    return Buffer.concat([await buf, dat])
  }, Buffer.alloc(0))
}

export default class Htsget extends BamFile {
  private baseUrl: string

  private trackId: string

  constructor(args: { trackId: string; baseUrl: string }) {
    // @ts-ignore override bam defaults
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
    const base = `${this.baseUrl}/${this.trackId}`
    const url = `${base}?referenceName=${chr}&start=${min}&end=${max}&format=BAM`
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
    const uncba = await concat(data.htsget.urls.slice(1))

    yield* this._fetchChunkFeatures(
      [{ buffer: uncba, chunk: { minv: { dataPosition: 0 } } }],
      chrId,
      min,
      max,
      opts,
    )
  }

  //@ts-ignore
  async _readChunk(params: { chunk: Buffer; opts: BaseOpts }, signal?: AbortSignal) {
    const { chunk, opts } = params
    const { buffer, chunk: c2 } = chunk
    // if (url.startsWith('data:')) {
    //   console.log('here')
    //   return
    // }
    // const res = await fetch(url, { ...opts, signal, headers })
    // const arrayBuffer = await res.arrayBuffer()
    // const buffer = Buffer.from(arrayBuffer)
    // const slice = await unzip(buffer, chunk)
    // const range = parseRange(Number.MAX_SAFE_INTEGER, headers.range)

    //@ts-ignore
    // chunk.minv = { dataPosition: range[0].start }
    return { data: buffer, cpositions: [0], dpositions: [0], chunk: c2 }
  }

  async getHeader(opts: BaseOpts = {}) {
    const url = `${this.baseUrl}/${this.trackId}?referenceName=na&class=header`
    const result = await fetch(url, opts)
    if (!result.ok) {
      throw new Error(`Failed to fetch ${result.statusText}`)
    }
    const data = await result.json()
    const uncba = await concat(data.htsget.urls, opts)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = uncba.readInt32LE(4)

    const headerText = uncba.toString('utf8', 8, 8 + headLen)
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
