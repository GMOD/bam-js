import { unzip } from '@gmod/bgzf-filehandle'

import BamFile, { BAM_MAGIC } from './bamFile.ts'
import Chunk from './chunk.ts'
import { parseHeaderText } from './sam.ts'
import { appendInRange, concatUint8Array } from './util.ts'
import { VirtualOffset } from './virtualOffset.ts'

import type { BamRecordClass, BamRecordLike } from './bamFile.ts'
import type BamRecord from './record.ts'
import type { BamOpts, BaseOpts } from './util.ts'

interface HtsgetChunk {
  url: string
  headers?: Record<string, string>
}

async function fetchOk(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${await res.text()}`)
  }
  return res
}

async function fetchChunk({ url, headers }: HtsgetChunk, opts?: RequestInit) {
  // pass base64 data URLs straight to fetch; otherwise apply headers (minus
  // referer, which isn't a permitted client-set header).
  // https://stackoverflow.com/a/54123275/2129219
  const { referer: _referer, ...rest } = headers ?? {}
  const res = url.startsWith('data:')
    ? await fetchOk(url)
    : await fetchOk(url, { ...opts, headers: rest })
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchAndConcat(arr: HtsgetChunk[], opts?: RequestInit) {
  // Pipeline unzip after each fetch so decompression overlaps later fetches.
  return concatUint8Array(
    await Promise.all(arr.map(async c => unzip(await fetchChunk(c, opts)))),
  )
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
    await this.getHeader(opts)
    const base = `${this.baseUrl}/${this.trackId}`
    const url = `${base}?referenceName=${chr}&start=${min}&end=${max}&format=BAM`
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined) {
      return []
    }
    const result = await fetchOk(url, opts)
    const data = await result.json()
    const uncba = await fetchAndConcat(data.htsget.urls.slice(1), {
      signal: opts?.signal,
    })

    const zero = new VirtualOffset(0, 0)
    const allRecords = await this.readBamFeatures(
      uncba,
      [],
      [],
      new Chunk(zero, zero, 0),
    )

    return appendInRange(allRecords, chrId, min, max)
  }

  async getHeaderPre(opts: BaseOpts = {}) {
    const url = `${this.baseUrl}/${this.trackId}?referenceName=na&class=header`
    const result = await fetchOk(url, opts)
    const data = await result.json()
    const uncba = await fetchAndConcat(data.htsget.urls, {
      signal: opts.signal,
    })
    const dataView = new DataView(uncba.buffer)

    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)

    const decoder = new TextDecoder()
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
