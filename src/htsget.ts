import { unzip } from '@gmod/bgzf-filehandle'
import { BaseOpts, BamOpts } from './util'
import BamFile, { BAM_MAGIC } from './bamFile'
import Chunk from './chunk'
import { parseHeaderText } from './sam'

interface HtsgetChunk {
  url: string
  headers?: Record<string, string>
}
async function concat(arr: HtsgetChunk[], opts: Record<string, any>) {
  const res = await Promise.all(
    arr.map(async chunk => {
      const { url, headers } = chunk
      if (url.startsWith('data:')) {
        return Buffer.from(url.split(',')[1], 'base64')
      } else {
        //remove referer header, it is not even allowed to be specified
        // @ts-expect-error
        //eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { referer, ...rest } = headers
        const res = await fetch(url, {
          ...opts,
          headers: { ...opts.headers, ...rest },
        })
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status} fetching ${url}: ${await res.text()}`,
          )
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
    super({ htsget: true })
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
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined) {
      yield []
    } else {
      const result = await fetch(url, { ...opts })
      if (!result.ok) {
        throw new Error(
          `HTTP ${result.status} fetching ${url}: ${await result.text()}`,
        )
      }
      const data = await result.json()
      const uncba = await concat(data.htsget.urls.slice(1), opts)

      yield* this._fetchChunkFeatures(
        [
          // fake stuff to pretend to be a Chunk
          {
            buffer: uncba,
            _fetchedSize: undefined,
            bin: 0,
            compareTo() {
              return 0
            },
            toUniqueString() {
              return `${chr}_${min}_${max}`
            },
            fetchedSize() {
              return 0
            },
            minv: {
              dataPosition: 0,
              blockPosition: 0,
              compareTo: () => 0,
            },
            maxv: {
              dataPosition: Number.MAX_SAFE_INTEGER,
              blockPosition: 0,
              compareTo: () => 0,
            },
            toString() {
              return `${chr}_${min}_${max}`
            },
          },
        ],
        chrId,
        min,
        max,
        opts,
      )
    }
  }

  async _readChunk({ chunk }: { chunk: Chunk; opts: BaseOpts }) {
    if (!chunk.buffer) {
      throw new Error('expected chunk.buffer in htsget')
    }
    return { data: chunk.buffer, cpositions: [], dpositions: [], chunk }
  }

  async getHeader(opts: BaseOpts = {}) {
    const url = `${this.baseUrl}/${this.trackId}?referenceName=na&class=header`
    const result = await fetch(url, opts)
    if (!result.ok) {
      throw new Error(
        `HTTP ${result.status} fetching ${url}: ${await result.text()}`,
      )
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
    const idToName: { refName: string; length: number }[] = []
    const nameToId: Record<string, number> = {}
    const sqLines = samHeader.filter(l => l.tag === 'SQ')
    sqLines.forEach((sqLine, refId) => {
      let refName = ''
      let length = 0
      sqLine.data.forEach(item => {
        if (item.tag === 'SN') {
          refName = item.value
        } else if (item.tag === 'LN') {
          length = +item.value
        }
      })
      nameToId[refName] = refId
      idToName[refId] = { refName, length }
    })
    this.chrToIndex = nameToId
    this.indexToChr = idToName
    return samHeader
  }
}
