import { unzip } from '@gmod/bgzf-filehandle'

import BamFile, { BAM_MAGIC } from './bamFile.ts'
import Chunk from './chunk.ts'
import BamRecord from './record.ts'
import { parseHeaderText } from './sam.ts'
import { concatUint8Array } from './util.ts'

import type { BamRecordClass, BamRecordLike } from './bamFile.ts'
import type { BamOpts, BaseOpts } from './util.ts'

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

export default class HtsgetFile<
  T extends BamRecordLike = BamRecord,
> extends BamFile<T> {
  private baseUrl: string

  private trackId: string

  constructor(args: {
    trackId: string
    baseUrl: string
    recordClass?: BamRecordClass<T>
  }) {
    super({ htsget: true, recordClass: args.recordClass })
    this.baseUrl = args.baseUrl
    this.trackId = args.trackId
  }

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    const base = `${this.baseUrl}/${this.trackId}`
    const url = `${base}?referenceName=${chr}&start=${min}&end=${max}&format=BAM`
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined) {
      return []
    }
    const result = await fetch(url, { ...opts })
    if (!result.ok) {
      throw new Error(
        `HTTP ${result.status} fetching ${url}: ${await result.text()}`,
      )
    }
    const data = await result.json()
    const uncba = await concat(data.htsget.urls.slice(1), opts)

    const allRecords = await this.readBamFeatures(uncba, [], [], {
      minv: { dataPosition: 0, blockPosition: 0 },
      maxv: { dataPosition: 0, blockPosition: 0 },
    } as Chunk)

    const records: T[] = []
    for (let i = 0, l = allRecords.length; i < l; i++) {
      const feature = allRecords[i]!
      if (feature.ref_id === chrId) {
        if (feature.start >= max) {
          break
        } else if (feature.end >= min) {
          records.push(feature)
        }
      }
    }
    return records
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
