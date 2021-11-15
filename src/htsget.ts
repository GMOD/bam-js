import { BaseOpts, BamOpts } from './util'
import BamFile, { BAM_MAGIC } from './bamFile'
import 'cross-fetch/polyfill'
import Chunk from './chunk'
import { unzip } from '@gmod/bgzf-filehandle'
import { parseHeaderText } from './sam'

interface HeaderLine {
  tag: string
  value: string
}

interface HtsgetChunk {
  url: string
  headers?: Record<string, string>
}
async function concat(arr: { url: string }[], opts: Record<string, any>) {
  const res = await Promise.all(
    arr.map(async (chunk: HtsgetChunk) => {
      const { url, headers } = chunk
      if (url.startsWith('data:')) {
        return Buffer.from(url.split(',')[1], 'base64')
      } else {
        //remove referer header, it is not even allowed to be specified
        //@ts-ignore
        //eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { referer, ...rest } = headers
        const res = await fetch(url, {
          ...opts,
          headers: { ...opts.headers, ...rest },
        })
        if (!res.ok) {
          throw new Error(`Failed to fetch ${res.statusText}`)
        }
        return Buffer.from(await res.arrayBuffer())
      }
    }),
  )

  return Buffer.concat(await Promise.all(res.map(elt => unzip(elt))))
}

export default class HtsgetFile extends BamFile {
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
    opts: BamOpts = {
      viewAsPairs: false,
      pairAcrossChr: false,
      maxInsertSize: 200000,
    },
  ) {
    const base = `${this.baseUrl}/${this.trackId}`
    const url = `${base}?referenceName=${chr}&start=${min}&end=${max}&format=BAM`
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(result.statusText)
    }
    const data = await result.json()
    const uncba = await concat(data.htsget.urls.slice(1), opts)
    const chunk = {
      buffer: uncba,
      chunk: { minv: { dataPosition: 0 } },
      toString() {
        return `${chr}_${min}_${max}`
      },
    }

    yield* this._fetchChunkFeatures(
      // @ts-ignore
      [chunk],
      chrId,
      min,
      max,
      opts,
    )
  }

  //@ts-ignore
  async _readChunk(params: {
    chunk: { buffer: Buffer; chunk: Chunk }
    opts: BaseOpts
  }) {
    const { chunk } = params
    const { buffer, chunk: c2 } = chunk
    return { data: buffer, cpositions: null, dpositions: null, chunk: c2 }
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
