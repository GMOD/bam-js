import { unzip } from '@gmod/bgzf-filehandle'

import BamFile from './bamFile.ts'
import Chunk from './chunk.ts'
import {
  BAM_MAGIC,
  appendInRange,
  concatUint8Array,
  parseRefSeqs,
} from './util.ts'
import { VirtualOffset } from './virtualOffset.ts'

import type {
  BamRecordClass,
  BamRecordLike,
  ReferenceSequenceFetcher,
} from './bamFile.ts'
import type BamRecord from './record.ts'
import type { BamOpts, BaseOpts } from './util.ts'
import type { Fetcher } from 'generic-filehandle2'

interface HtsgetChunk {
  url: string
  headers?: Record<string, string>
  // present on either all of a ticket's urls or none; only a hint, since the
  // blocks still have to be concatenated in ticket order either way
  class?: 'header' | 'body'
}

interface HtsgetTicket {
  htsget: { urls: HtsgetChunk[] }
}

interface HtsgetErrorBody {
  htsget?: { error?: string; message?: string }
}

// Errors carry a JSON body naming the error type, e.g. {"htsget":
// {"error":"InvalidAuthentication","message":"..."}}. Surface that rather than
// the raw payload, since 401/403 are the first thing a misconfigured token hits.
function htsgetErrorMessage(text: string) {
  let parsed: HtsgetErrorBody | undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON, fall through to the raw body
  }
  const err = parsed?.htsget
  return err?.error === undefined
    ? text
    : err.message === undefined
      ? err.error
      : `${err.error}: ${err.message}`
}

/**
 * Offset of the first alignment record in the concatenated ticket blocks.
 *
 * The spec has the client concatenate the blocks in ticket order to get a
 * complete data stream, so whether the header is its own block is up to the
 * server: htsnexus splits it into a leading `data:` url, while htsget-rs
 * returns header and records together in a single url. Either way the
 * concatenation starts with the BAM header, so seek past it rather than
 * dropping blocks — a url count or class attribute can't tell the two layouts
 * apart. Returns 0 when the stream has no header, which is what a server
 * sending body-only blocks produces.
 */
function recordsOffset(uncba: Uint8Array) {
  const dataView = new DataView(
    uncba.buffer,
    uncba.byteOffset,
    uncba.byteLength,
  )
  if (uncba.byteLength < 8 || dataView.getInt32(0, true) !== BAM_MAGIC) {
    return 0
  }
  const refs = parseRefSeqs(uncba, 8 + dataView.getInt32(4, true), n => n)
  if (!refs) {
    throw new Error('truncated BAM header in htsget response')
  }
  return refs.end
}

async function fetchOk(fetchFn: Fetcher, url: string, opts?: RequestInit) {
  const res = await fetchFn(url, opts)
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} fetching ${url}: ${htsgetErrorMessage(await res.text())}`,
    )
  }
  return res
}

async function fetchChunk(
  fetchFn: Fetcher,
  { url, headers }: HtsgetChunk,
  opts?: RequestInit,
) {
  // pass base64 data URLs straight to fetch; otherwise apply headers (minus
  // referer, which isn't a permitted client-set header).
  // https://stackoverflow.com/a/54123275/2129219
  const { referer: _referer, ...rest } = headers ?? {}
  const res = url.startsWith('data:')
    ? await fetchOk(fetchFn, url)
    : await fetchOk(fetchFn, url, { ...opts, headers: rest })
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchAndConcat(
  fetchFn: Fetcher,
  arr: HtsgetChunk[],
  opts?: RequestInit,
) {
  // Pipeline unzip after each fetch so decompression overlaps later fetches.
  return concatUint8Array(
    await Promise.all(
      arr.map(async c => unzip(await fetchChunk(fetchFn, c, opts))),
    ),
  )
}

export default class HtsgetFile<
  T extends BamRecordLike = BamRecord,
> extends BamFile<T> {
  private baseUrl: string

  private trackId: string

  private fetchFn: Fetcher

  constructor(args: {
    trackId: string
    baseUrl: string
    recordClass?: BamRecordClass<T>
    /**
     * fetch implementation used for every request, so an `Authorization: Bearer
     * <token>` header can be added for servers that require one. It is also
     * called with the data-block urls from the ticket, which may point at
     * third-party hosts, so only attach credentials to hosts you trust — the
     * spec has servers put whatever a data block needs in that url's own
     * `headers` field, which is applied either way.
     */
    fetch?: Fetcher
    /**
     * Passed on to {@link BamFile}, where it bounds `chunkFeatureCache` —
     * which htsget mode never fills. `getRecordsForRange` below reads whole
     * ticket blocks rather than index chunks, so nothing here reaches that
     * cache and neither of these options changes anything today. Accepted
     * rather than rejected because the inherited cache is the thing that
     * should eventually hold ticket responses (there is no read sharing or
     * reuse in htsget mode at all right now), and that is when they start to
     * bite.
     */
    maxCacheBytes?: number
    /** see {@link maxCacheBytes}: inherited, and inert in htsget mode */
    cacheIdleTimeoutMs?: number
    /**
     * Reference bases for reads with no `MD` tag — see {@link BamFile}'s option
     * of the same name. Unlike the cache options this one is live here: an
     * htsget query resolves its reads' mismatches exactly as an indexed one
     * does.
     */
    fetchReferenceSequence?: ReferenceSequenceFetcher
  }) {
    super({
      htsget: true,
      recordClass: args.recordClass,
      maxCacheBytes: args.maxCacheBytes,
      cacheIdleTimeoutMs: args.cacheIdleTimeoutMs,
      fetchReferenceSequence: args.fetchReferenceSequence,
    })
    this.baseUrl = args.baseUrl
    this.trackId = args.trackId
    this.fetchFn = args.fetch ?? ((input, init) => fetch(input, init))
  }

  /**
   * Requests a ticket and returns its data blocks decompressed and
   * concatenated, which per the spec is a complete BAM stream.
   */
  private async fetchTicket(query: string, opts?: BaseOpts) {
    const url = `${this.baseUrl}/${this.trackId}?${query}`
    const res = await fetchOk(this.fetchFn, url, { signal: opts?.signal })
    const ticket: HtsgetTicket = await res.json()
    return fetchAndConcat(this.fetchFn, ticket.htsget.urls, {
      signal: opts?.signal,
    })
  }

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    await this.getHeader(opts)
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined) {
      return []
    }
    const uncba = await this.fetchTicket(
      `referenceName=${chr}&start=${min}&end=${max}&format=BAM`,
      opts,
    )
    const zero = new VirtualOffset(0, 0)
    const records = this.readBamFeatures(
      uncba.subarray(recordsOffset(uncba)),
      [],
      [],
      new Chunk(zero, zero, 0),
    )
    const result = appendInRange(records, chrId, min, max)
    await this._applyReferenceSequence(result, chrId, chr, opts)
    return result
  }

  async getHeaderPre(opts: BaseOpts = {}) {
    // format is the only parameter the spec permits alongside class=header;
    // servers SHOULD reject anything else with InvalidInput
    const uncba = await this.fetchTicket('class=header&format=BAM', opts)
    const samHeader = this.applyHeader(uncba)
    if (!samHeader) {
      throw new Error('Insufficient data for reference sequences')
    }
    return samHeader
  }
}
