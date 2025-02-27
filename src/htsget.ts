import { unzip } from '@gmod/bgzf-filehandle'

import BamFile, { BAM_MAGIC } from './bamFile'
import Chunk from './chunk'
import { parseHeaderText } from './sam'
import { BamOpts, BaseOpts, concatUint8Array } from './util'

interface HtsgetChunk {
  url: string
  headers?: Record<string, string>
}
async function concat(arr: HtsgetChunk[], opts?: Record<string, any>) {
  const res = await Promise.all(
    arr.map(async chunk => {
      const { url, headers } = chunk
      if (url.startsWith('data:')) {
        // pass base64 data url to fetch to decode to buffer
        // https://stackoverflow.com/a/54123275/2129219
        const res = await fetch(url)
        if (!res.ok) {
          throw new Error('failed to decode base64')
        }
        const ret = await res.arrayBuffer()
        return new Uint8Array(ret)
      } else {
        // remove referer header, it is not even allowed to be specified
        // @ts-expect-error

        const { referer, ...rest } = headers
        const res = await fetch(url, {
          ...opts,
          headers: { ...opts?.headers, ...rest },
        })
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status} fetching ${url}: ${await res.text()}`,
          )
        }
        return new Uint8Array(await res.arrayBuffer())
      }
    }),
  )

  return concatUint8Array(await Promise.all(res.map(elt => unzip(elt))))
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
    opts?: BamOpts,
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

  // @ts-expect-error
  async _readChunk({ chunk }: { chunk: Chunk; opts: BaseOpts }) {
    if (!chunk.buffer) {
      throw new Error('expected chunk.buffer in htsget')
    }
    return {
      data: chunk.buffer,
      cpositions: [],
      dpositions: [],
      chunk,
    }
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
    const dataView = new DataView(uncba.buffer)

    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)

    const decoder = new TextDecoder('utf8')
    const headerText = decoder.decode(uncba.subarray(8, 8 + headLen))
    const samHeader = parseHeaderText(headerText)

    // use the @SQ lines in the header to figure out the
    // mapping between ref ref ID numbers and names
    const idToName: { refName: string; length: number }[] = []
    const nameToId: Record<string, number> = {}
    const sqLines = samHeader.filter(l => l.tag === 'SQ')
    for (const [refId, sqLine] of sqLines.entries()) {
      let refName = ''
      let length = 0
      for (const item of sqLine.data) {
        if (item.tag === 'SN') {
          refName = item.value
        } else if (item.tag === 'LN') {
          length = +item.value
        }
      }
      nameToId[refName] = refId
      idToName[refId] = { refName, length }
    }
    this.chrToIndex = nameToId
    this.indexToChr = idToName
    return samHeader
  }
}
