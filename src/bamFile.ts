import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import { SharedReadCache } from '@gmod/shared-read-cache'
import crc32 from 'crc/calculators/crc32'
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import BAI from './bai.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import { appendInRange, parseRefSeqs, throwIfAborted } from './util.ts'

import type Chunk from './chunk.ts'
import type { BamOpts, BaseOpts } from './util.ts'
import type { GenericFilehandle } from 'generic-filehandle2'

export interface BamRecordLike {
  ref_id: number
  start: number
  end: number
  name: string
  fileOffset: number
  next_pos: number
  next_refid: number
  flags: number
  tags: Record<string, unknown>
}

export type BamRecordClass<T extends BamRecordLike = BAMFeature> = new (
  byteArray: Uint8Array,
  start: number,
  end: number,
  fileOffset: number,
  dataView: DataView,
) => T

export const BAM_MAGIC = 21840194

const blockLen = 1 << 16

// Ceiling on GROWING the header read. A million contigs is roughly 10MB of
// compressed @SQ lines and ref-seq table, so a read that has doubled past this
// is chasing a corrupt header claiming a huge n_ref rather than a real one, and
// growing further just downloads the file. It does not cap the FIRST read: that
// length comes from the index's firstDataLine, which is a real offset rather
// than a guess, so a header that genuinely runs past this still gets its one
// exact read. See getHeaderPre.
const maxHeaderReadLen = 32 * 1024 * 1024

function resolveFilehandle(
  filehandle?: GenericFilehandle,
  path?: string,
  url?: string,
) {
  return (
    filehandle ??
    (path ? new LocalFile(path) : url ? new RemoteFile(url) : undefined)
  )
}

interface ChunkEntry<T> {
  // decompressed size of the chunk these features are views into
  bytes: number
  features: T[]
}

/**
 * Whether a chunk's first record already lies past `chrId:..-max`, which means
 * every later chunk does too and none of them need to be read.
 *
 * Sound because of two orderings that already hold. `optimizeChunks` returns
 * chunks sorted by `minv.blockPosition`, and a coordinate-sorted BAM stores
 * records in (ref_id, start) order — so chunk i's first record is at or before
 * chunk i+1's, and a chunk whose first record is past the query has only
 * past-the-query records behind it.
 *
 * That coordinate-sorted assumption is not new: `appendInRange` already breaks
 * out of a chunk on exactly it. This applies the same rule one level up, so a
 * BAM that violates it was already returning short results before this existed.
 *
 * `first.ref_id > chrId` matters as much as the position: `optimizeChunks`
 * merges spans up to 5MB, which can carry a chunk across a reference boundary.
 *
 * An empty chunk says nothing about position, so it never stops the walk.
 */
function isPastQuery(
  features: { ref_id: number; start: number }[] | undefined,
  chrId: number,
  max: number,
) {
  const first = features?.[0]
  return (
    !!first &&
    (first.ref_id > chrId || (first.ref_id === chrId && first.start >= max))
  )
}

function chunkCacheKey(chunk: Chunk) {
  const { minv, maxv } = chunk
  return `${minv.blockPosition}:${minv.dataPosition}-${maxv.blockPosition}:${maxv.dataPosition}`
}

// Every record in an entry is a view into its chunk's decompressed buffer, so
// caching one entry pins that whole buffer. A count-based LRU therefore gives no
// bound on memory at all, which is why this budgets by decompressed bytes.
//
// Sized to hold SEVERAL of the largest query a consumer will issue, not one. A
// budget below a single query's working set does not merely cache less — it
// evicts each chunk before the next pan can reuse it, so the hit rate is zero
// and the re-decompress is paid every time (ADR 0014).
//
// What sets that scale is the caller's own byte gate, not how deep data can get.
// jbrowse compares `estimatedBytesForRegions` — COMPRESSED bytes, from the index
// — against its `fetchSizeLimit` and refuses to query above it. Default 5MB
// compressed; its own SV demo raises that to 30MB for PacBio HiFi. At the 2.1-7.3x
// BGZF ratios measured across the jb2bench corpus, that is 10-37MB decompressed
// per query at the stock gate and 63-219MB at the raised one, so six pan windows
// want ~219MB and ~378MB respectively.
//
// 1GB clears both with room for the deepest data measured — a six-window pan on
// 1000x long-read peaks at 569MB — and is affordable only because of
// DEFAULT_CACHE_IDLE_TIMEOUT_MS below. It is a ceiling under active panning, not
// a resting level, and it costs a consumer on ordinary data nothing either way:
// 20x short-read holds 7MB here whatever this is set to.
export const DEFAULT_MAX_CACHE_BYTES = 1024 * 1024 * 1024

// Drop a chunk nothing has looked at for three minutes.
//
// This is what makes the ceiling above affordable rather than alarming. jbrowse
// memoizes one BamFile per adapter for the life of the track and passes no
// budget, so without this a tab parked on a deep region holds its whole last
// view until the track is closed, times every track open. The budget alone
// cannot lower that: it is enforced when a read settles, so an idle cache stays
// wherever it got to.
//
// Three minutes rather than seconds because the point is to catch a user who has
// gone away, not one who is reading the screen in front of them. A pan back to a
// region a minute later should still hit (ADR 0015).
export const DEFAULT_CACHE_IDLE_TIMEOUT_MS = 3 * 60 * 1000

// How many of a query's chunks to read at once. Six is the HTTP/1.1
// per-host connection cap browsers enforce, so going much above it buys
// nothing on the transport that matters and only widens peak memory.
const MAX_CONCURRENT_CHUNK_READS = 6

export default class BamFile<T extends BamRecordLike = BAMFeature> {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
  public htsget = false
  public headerP?: ReturnType<BamFile<T>['getHeaderPre']>
  /**
   * The signal `headerP` was started under, while it is still in flight. The
   * header is parsed once and every query awaits it, so without this the first
   * query to arrive would own a read all the others depend on — see
   * {@link getHeader}.
   */
  private headerSignal?: AbortSignal

  // Parsed features by chunk, bounded by decompressed bytes. Also the
  // in-flight map: concurrent queries for the same chunk share one read rather
  // than racing to decompress it twice.
  public chunkFeatureCache: SharedReadCache<Chunk, ChunkEntry<T>>

  private RecordClass: BamRecordClass<T>

  constructor({
    bamFilehandle,
    bamPath,
    bamUrl,
    baiPath,
    baiFilehandle,
    baiUrl,
    csiPath,
    csiFilehandle,
    csiUrl,
    htsget,
    renameRefSeqs = n => n,
    recordClass,
    maxCacheBytes = DEFAULT_MAX_CACHE_BYTES,
    cacheIdleTimeoutMs = DEFAULT_CACHE_IDLE_TIMEOUT_MS,
  }: {
    bamFilehandle?: GenericFilehandle
    bamPath?: string
    bamUrl?: string
    baiPath?: string
    baiFilehandle?: GenericFilehandle
    baiUrl?: string
    csiPath?: string
    csiFilehandle?: GenericFilehandle
    csiUrl?: string
    renameRefSeqs?: (a: string) => string
    htsget?: boolean
    recordClass?: BamRecordClass<T>
    /**
     * Budget for the parsed-chunk cache, in decompressed bytes. Defaults to
     * {@link DEFAULT_MAX_CACHE_BYTES}.
     *
     * A **retention** bound, not a bound on peak memory, and the difference is
     * not small on deep data. Three things sit outside it: a read still in
     * flight is never evicted, and up to `MAX_CONCURRENT_CHUNK_READS` of those
     * run at once; the last settled entry is kept whatever the budget; and a
     * query holds every chunk it parsed until it returns, whether or not the
     * cache still does. On 1000x long-read data a single chunk decompresses to
     * 180MB and six in flight is 476MB, neither of which this number can bound.
     *
     * Set it too low and the cache does not degrade gracefully — it inverts. A
     * budget under one query's working set evicts each chunk before the next pan
     * reuses it, so the hit rate is zero, the full re-decompress is paid on every
     * pan, and the memory is retained anyway. Size it to hold several queries or
     * pass `Infinity` and bound memory some other way; do not pick a number
     * between the two (ADR 0014).
     */
    maxCacheBytes?: number
    /**
     * Drop a cached chunk once nothing has asked for it for this many
     * milliseconds. Defaults to {@link DEFAULT_CACHE_IDLE_TIMEOUT_MS}; pass
     * `0` to keep chunks until `maxCacheBytes` evicts them.
     *
     * This is the only thing that lowers the cache while a consumer sits still,
     * and the reason `maxCacheBytes` can afford to be generous — it makes the
     * budget a peak under panning rather than a resting level. The clock runs
     * from the last read of a chunk, not from when it was parsed, so panning
     * back and forth over the same region never expires it (ADR 0015).
     */
    cacheIdleTimeoutMs?: number
  }) {
    this.renameRefSeq = renameRefSeqs
    this.RecordClass = (recordClass ?? BAMFeature) as BamRecordClass<T>
    this.chunkFeatureCache = new SharedReadCache<Chunk, ChunkEntry<T>>({
      maxSize: maxCacheBytes,
      idleTimeoutMs: cacheIdleTimeoutMs,
      // decompressed bytes, not entry count: parsed records are views into
      // their chunk's decompressed buffer, so a cached entry pins that whole
      // buffer and entry count says nothing about memory
      sizeOf: entry => entry.bytes,
      cacheKey: chunkCacheKey,
      fill: (chunk, signal) => this._readChunkFeatures(chunk, { signal }),
    })

    const bamFh = resolveFilehandle(bamFilehandle, bamPath, bamUrl)
    if (bamFh) {
      this.bam = bamFh
    } else if (htsget) {
      this.htsget = true
      this.bam = new NullFilehandle()
    } else {
      throw new Error(
        'no bam source: pass bamFilehandle, bamPath, bamUrl, or htsget: true',
      )
    }

    const csiFh = resolveFilehandle(csiFilehandle, csiPath, csiUrl)
    const baiFh =
      resolveFilehandle(baiFilehandle, baiPath, baiUrl) ??
      resolveFilehandle(
        undefined,
        bamPath ? `${bamPath}.bai` : undefined,
        bamUrl ? `${bamUrl}.bai` : undefined,
      )
    if (csiFh) {
      this.index = new CSI({ filehandle: csiFh })
    } else if (baiFh) {
      this.index = new BAI({ filehandle: baiFh })
    } else if (!htsget) {
      throw new Error(
        'no index source: pass csi*/bai* options or a bamPath/bamUrl so the .bai sibling can be inferred',
      )
    }
    // htsget mode operates without a parsed index
  }

  async getHeaderPre(opts: BaseOpts = {}) {
    if (!this.index) {
      // Only reachable via `new BamFile({htsget: true})` used directly rather
      // than through HtsgetFile, which overrides this. Throwing rather than
      // returning undefined keeps `| undefined` off getHeader()'s public type,
      // and makes that misuse loud instead of silently answering every query
      // with zero records (getSeqId would find no chrToIndex).
      throw new Error(
        'no index to read a header from: use HtsgetFile for htsget sources',
      )
    }
    const indexData = await this.index.parse(opts)

    // The records start at firstDataLine, so reading up to it plus the bgzf
    // block straddling it covers the header. It is undefined when the index
    // records no data at all (header-only BAM), and it undershoots when the
    // index leaves offsets unset, so grow the read until the ref-seq table
    // parses. Never readFile() here: on a remote BAM that is a whole-file
    // download to read a header.
    let readLen =
      indexData.firstDataLine === undefined
        ? blockLen
        : indexData.firstDataLine.blockPosition + blockLen

    // do/while, so the index-derived length is always read once and only the
    // doubling is bounded. Testing readLen before the first read instead meant
    // a BAM whose header genuinely exceeds maxHeaderReadLen — millions of
    // contigs — was rejected without a single byte being fetched, and reported
    // as 'Insufficient data for reference sequences' when the data was there.
    let samHeader
    let atEof: boolean
    do {
      const buffer = await this.bam.read(readLen, 0, { signal: opts.signal })
      // a short read means readLen ran past the end of the file, so there are
      // no more bytes to grow into
      atEof = buffer.length < readLen
      samHeader = this.applyHeader(await unzip(buffer))
      readLen *= 2
    } while (samHeader === undefined && !atEof && readLen <= maxHeaderReadLen)
    if (samHeader === undefined) {
      throw new Error('Insufficient data for reference sequences')
    }
    return samHeader
  }

  /**
   * Installs the header text and ref name/id maps from the start of a
   * decompressed BAM stream, returning the parsed SAM header lines. Returns
   * undefined if the stream is cut off partway through the ref-seq table, so
   * the caller can retry with more data.
   */
  protected applyHeader(uncba: Uint8Array) {
    const dataView = new DataView(
      uncba.buffer,
      uncba.byteOffset,
      uncba.byteLength,
    )
    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)
    const parsed = parseRefSeqs(uncba, headLen + 8, this.renameRefSeq)
    let samHeader
    if (parsed) {
      const headerText = new TextDecoder('utf8').decode(
        uncba.subarray(8, 8 + headLen),
      )
      this.header = headerText
      this.chrToIndex = parsed.chrToIndex
      this.indexToChr = parsed.indexToChr
      samHeader = parseHeaderText(headerText)
    }
    return samHeader
  }

  /**
   * Parse the header, or join the parse already running.
   *
   * The header is parsed once for the life of this object and every query goes
   * through it — `getSeqId` awaits it before anything else — so it is a read
   * shared between queries, and the third place in this file where a
   * cancellation could leak from the query that asked for it to a query that
   * did not. `getHeaderPre` threads `opts` into both the index parse and the
   * BAM read, so without this the first query to arrive owns a read every other
   * query depends on: when it pans away, every concurrent query fails with its
   * abort even though its own signal is untouched.
   *
   * Same bounded retry as `IndexFile.parse`, for the same reason — the header
   * is parsed once, so there is no repeated waste to recover — and bounded at
   * one attempt so the pathological case is a duplicate parse rather than a
   * recursion whose depth depends on how the aborts interleave.
   *
   * SYNC: ~/src/gmod/tabix-js/src/tabixIndexedFile.ts getParsedHeader — same
   * shape for the same reason.
   */
  async getHeader(
    opts?: BaseOpts,
    retried = false,
  ): Promise<Awaited<ReturnType<BamFile<T>['getHeaderPre']>>> {
    throwIfAborted(opts?.signal)
    const pending = this.headerP
    if (!pending) {
      return this.startHeaderParse(opts)
    }

    // read before awaiting: the owner is forgotten as soon as the parse settles
    const ownerSignal = this.headerSignal
    try {
      return await pending
    } catch (e) {
      if (retried || !ownerSignal?.aborted || opts?.signal?.aborted) {
        throw e
      }
      return this.getHeader(opts, true)
    }
  }

  private startHeaderParse(opts?: BaseOpts) {
    const pending = this.getHeaderPre(opts)
    this.headerP = pending
    this.headerSignal = opts?.signal
    // Drop a rejection rather than keeping it, so one transient failure does not
    // poison the header for the lifetime of the file. Both branches are
    // identity-checked so a retry started after this settles is not cleared by
    // the attempt it already replaced.
    pending.then(
      () => {
        if (this.headerP === pending) {
          this.headerSignal = undefined
        }
      },
      () => {
        if (this.headerP === pending) {
          this.headerP = undefined
          this.headerSignal = undefined
        }
      },
    )
    return pending
  }

  async getHeaderText(opts: BaseOpts = {}) {
    await this.getHeader(opts)
    return this.header
  }

  // Resolve a reference name to its numeric id, ensuring the header (which
  // populates chrToIndex) has been parsed first.
  private async getSeqId(seqName: string, opts?: BaseOpts) {
    await this.getHeader(opts)
    return this.chrToIndex?.[seqName]
  }

  /**
   * Records overlapping `chr:min-max`.
   *
   * The returned records are CACHED AND SHARED — two queries resolving to the
   * same chunk span get the same objects back, so treat them as read-only.
   * Anything you want to attach for the duration of one query belongs on a
   * wrapper you own, never on the record; writing a field here silently rebinds
   * it for every other query still holding that read. See ADR 0006.
   */
  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    throwIfAborted(opts?.signal)
    const chrId = await this.getSeqId(chr, opts)
    if (chrId === undefined || !this.index) {
      return []
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    return this._fetchChunkFeatures(chunks, chrId, min, max, opts)
  }

  // Parsed records for a chunk, reading and decompressing it only on a miss.
  // Every path that wants a chunk's features goes through here — mate lookups
  // included, since a viewAsPairs query revisits the same mate chunks each time
  // the view moves.
  //
  // This hands the SAME record objects to every query that hits the key, which
  // is what makes callers' per-query writes onto a record leak across queries
  // (ADR 0006). Caching the inflated buffer and re-scanning per query would give
  // each caller its own objects, but roughly doubles a warm query on dense data
  // — measured, and rejected, in that ADR.
  private async _cachedChunkFeatures(
    chunk: Chunk,
    opts: BaseOpts,
  ): Promise<T[]> {
    // The cache does the rest: one read per chunk shared by every caller that
    // asks for it while it is in flight, cancelled only once every one of them
    // has given up (ADR 0007), and bounded by decompressed bytes.
    const entry = await this.chunkFeatureCache.get(chunk, opts.signal)
    return entry.features
  }

  private async _fetchChunkFeatures(
    chunks: Chunk[],
    chrId: number,
    min: number,
    max: number,
    opts: BamOpts = {},
  ) {
    const { viewAsPairs, onProgress } = opts
    const result: T[] = []

    let totalBytes = 0
    for (let ci = 0, cl = chunks.length; ci < cl; ci++) {
      totalBytes += chunks[ci]!.fetchedSize()
    }
    let downloadedBytes = 0
    onProgress?.(0, totalBytes)

    const featureLists = new Array<T[] | undefined>(chunks.length)
    if (chunks.length === 1) {
      // Very common — most small files, and any query landing inside one bin.
      // Worth its own path: the pool below allocates a closure, a worker array
      // and a Promise.all, all of which is pure overhead for one chunk and
      // measurable on queries that take ~0.2ms.
      featureLists[0] = await this._cachedChunkFeatures(chunks[0]!, opts)
      onProgress?.(totalBytes, totalBytes)
    } else {
      // Fetch the chunks concurrently. A query routinely spans a dozen or more
      // chunks (14.8 on average for a 20kb window on the test 18MB file) and
      // each is its own range request, so reading them one after another costs
      // a network round trip apiece — the dominant cost of a remote query, well
      // ahead of decompression. Bounded because browsers cap concurrent
      // connections per host anyway, and an unbounded fan-out would inflate
      // every chunk of a whole-chromosome query at once.
      const readOne = async (ci: number) => {
        const chunk = chunks[ci]!
        featureLists[ci] = await this._cachedChunkFeatures(chunk, opts)
        downloadedBytes += chunk.fetchedSize()
        onProgress?.(downloadedBytes, totalBytes)
      }

      // One barrier, after the first batch, then the pool for the rest.
      //
      // The barrier is what makes the early stop DETERMINISTIC: the batch is
      // chunks [0, MAX_CONCURRENT_CHUNK_READS), fixed by index rather than by
      // which read happens to finish first, so the decision cannot depend on
      // timing or on what the chunk cache already holds. An earlier attempt
      // checked the stop inside the pool instead, and a warm cache raced past
      // it — the same query read 6 chunks cold and 9 warm, so a repeat query
      // did MORE I/O than the first (ADR 0010).
      //
      // Only ONE barrier, rather than one per wave, because the stop — when
      // there is one — always fired inside the first batch on every fixture
      // measured (the first 1-3 chunks). A query that gets through the batch
      // without stopping is one that needs its chunks, so it runs the
      // unbarriered pool exactly as before. That caps the cost of being wrong
      // at 0.92x-0.95x, against 0.82x-0.88x for barriering every wave.
      const batch = Math.min(MAX_CONCURRENT_CHUNK_READS, chunks.length)
      await Promise.all(Array.from({ length: batch }, (_, ci) => readOne(ci)))
      let stopped = false
      for (let ci = 0; ci < batch; ci++) {
        if (isPastQuery(featureLists[ci], chrId, max)) {
          stopped = true
          break
        }
      }

      if (!stopped && chunks.length > batch) {
        let next = batch
        const readNext = async () => {
          while (next < chunks.length) {
            await readOne(next++)
          }
        }
        const workers = Math.min(
          MAX_CONCURRENT_CHUNK_READS,
          chunks.length - batch,
        )
        await Promise.all(Array.from({ length: workers }, () => readNext()))
      }
      // A determinate bar must still reach its total after an early stop.
      onProgress?.(totalBytes, totalBytes)
    }

    // Append in chunk order, not completion order, so the result is the same
    // sequence a sequential walk produced. (That is not coordinate order — bins
    // at different levels cover overlapping spans — but it is what every caller
    // has always been handed.)
    for (let ci = 0, cl = chunks.length; ci < cl; ci++) {
      // undefined for chunks the early stop skipped
      const features = featureLists[ci]
      if (features) {
        appendInRange(features, chrId, min, max, result)
      }
    }

    if (viewAsPairs) {
      const pairs = await this.fetchPairs(chrId, result, opts)
      for (let i = 0, l = pairs.length; i < l; i++) {
        result.push(pairs[i]!)
      }
    }

    return result
  }

  async fetchPairs(chrId: number, records: T[], opts: BamOpts) {
    const { pairAcrossChr, maxInsertSize = 200000 } = opts
    // Map, not a plain object: read names come from the file, and on a plain
    // object a read named "constructor" would read back Object.prototype's and
    // make the count NaN.
    const readNameCounts = new Map<string, number>()
    const readIds = new Set<number>()

    for (let i = 0, l = records.length; i < l; i++) {
      const r = records[i]!
      const name = r.name
      readNameCounts.set(name, (readNameCounts.get(name) ?? 0) + 1)
      readIds.add(r.fileOffset)
    }

    const matePromises: Promise<Chunk[]>[] = []
    for (let i = 0, l = records.length; i < l; i++) {
      const f = records[i]!
      const name = f.name
      if (
        this.index &&
        readNameCounts.get(name) === 1 &&
        (pairAcrossChr ||
          (f.next_refid === chrId &&
            Math.abs(f.start - f.next_pos) < maxInsertSize))
      ) {
        matePromises.push(
          this.index.blocksForRange(
            f.next_refid,
            f.next_pos,
            f.next_pos + 1,
            opts,
          ),
        )
      }
    }

    const map = new Map<string, Chunk>()
    const res = await Promise.all(matePromises)
    for (let i = 0, l = res.length; i < l; i++) {
      const chunks = res[i]!
      for (let j = 0, jl = chunks.length; j < jl; j++) {
        const m = chunks[j]!
        // Key on the virtual-offset span — the same key _cachedChunkFeatures
        // uses. Chunk.toString() also folds in `bin` and fetchedSize(), which
        // keeps two chunks covering an identical span apart here even though
        // the cache below collapses them, so their records came back twice.
        map.set(chunkCacheKey(m), m)
      }
    }
    const mateChunks = [...map.values()]

    // Bounded for the reason ADR 0008 bounds the main query path: a viewAsPairs
    // query over a busy region resolves to many distinct mate chunks, and an
    // unbounded fan-out inflates every one of them at once. Same inline pool
    // shape as _fetchChunkFeatures — ADR 0009 measured extracting a shared
    // mapConcurrent helper at ~11% on the hot path, so it stays inline.
    const mateFeatLists = new Array<T[]>(mateChunks.length)
    let next = 0
    const readNext = async () => {
      while (next < mateChunks.length) {
        const ci = next++
        const features = await this._cachedChunkFeatures(mateChunks[ci]!, opts)
        const mateRecs = [] as T[]
        for (let i = 0, l = features.length; i < l; i++) {
          const feature = features[i]!
          // fileOffset first: it is a number already on the record, where
          // `name` decodes a string per record. A mate chunk usually overlaps
          // the query region, so this skips the decode for every record the
          // caller is already holding.
          if (
            !readIds.has(feature.fileOffset) &&
            readNameCounts.get(feature.name) === 1
          ) {
            mateRecs.push(feature)
          }
        }
        mateFeatLists[ci] = mateRecs
      }
    }
    const workers = Math.min(MAX_CONCURRENT_CHUNK_READS, mateChunks.length)
    await Promise.all(Array.from({ length: workers }, () => readNext()))
    return mateFeatLists.flat()
  }

  async _readChunkFeatures(chunk: Chunk, opts: BaseOpts) {
    // Don't forward onProgress to the inner read: getRecordsForRange already
    // reports progress at chunk granularity (downloadedBytes/totalBytes). If the
    // filehandle's own streaming onProgress also fired this callback it would
    // report a different `total` (this chunk's size, not the whole query),
    // making the determinate bar jump around.
    const buf = await this.bam.read(
      chunk.fetchedSize(),
      chunk.minv.blockPosition,
      {
        signal: opts.signal,
      },
    )
    // The last chance to bail before the expensive part, and the reason it is
    // worth having: honouring the signal is optional in the filehandle.
    // `RemoteFile` hands it to `fetch`, but `LocalFile.read(length, position)`
    // does not even take an options argument, so every read under it runs to
    // completion and arrives here with the cancellation unnoticed. Without this
    // a fully abandoned chunk still gets inflated and decoded — measured at 6
    // chunks for one 20kb query on out.bam — which is the dominant cost of a
    // cold query (ADR 0003), spent on records nobody will ever look at.
    //
    // Safe precisely because this is the SHARED signal, not a caller's: it
    // fires only once every waiter has given up, so there is never a live
    // caller left to be denied the result. @gmod/cram checks in the same place
    // and for the same reason, before the decode loop in `_fetchRecords`.
    throwIfAborted(opts.signal)

    const {
      buffer: data,
      cpositions,
      dpositions,
    } = await unzipChunkSlice(buf, chunk)
    return {
      features: this.readBamFeatures(data, cpositions, dpositions, chunk),
      bytes: data.byteLength,
    }
  }

  // cpositions/dpositions are `ArrayLike`, not `number[]`, because the wasm
  // decompressor produces them as Float64Arrays — @gmod/bgzf-filehandle spreads
  // them into plain arrays on the way out, and this signature is what lets that
  // copy be dropped there without a change here. Only indexed reads and
  // `.length` are used below either way.
  readBamFeatures(
    ba: Uint8Array,
    cpositions: ArrayLike<number>,
    dpositions: ArrayLike<number>,
    chunk: Chunk,
  ) {
    let blockStart = 0
    const sink = [] as T[]
    let pos = 0

    const dataView = new DataView(ba.buffer, ba.byteOffset, ba.byteLength)
    const hasDpositions = dpositions.length > 0
    const hasCpositions = cpositions.length > 0

    while (blockStart + 4 < ba.length) {
      const blockSize = dataView.getInt32(blockStart, true)
      const blockEnd = blockStart + 4 + blockSize - 1

      if (hasDpositions) {
        const target = blockStart + chunk.minv.dataPosition
        while (pos < dpositions.length && target >= dpositions[pos]!) {
          pos++
        }
      }

      if (blockEnd < ba.length) {
        const feature = new this.RecordClass(
          ba,
          blockStart,
          blockEnd,
          hasCpositions
            ? cpositions[pos]! * (1 << 8) +
                (blockStart - dpositions[pos]!) +
                chunk.minv.dataPosition +
                1
            : crc32(ba.subarray(blockStart, blockEnd)) >>> 0,
          dataView,
        )

        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  async hasRefSeq(seqName: string, opts?: BaseOpts) {
    const seqId = await this.getSeqId(seqName, opts)
    return !this.index || seqId === undefined
      ? false
      : this.index.hasRefSeq(seqId)
  }

  async lineCount(seqName: string, opts?: BaseOpts) {
    const seqId = await this.getSeqId(seqName, opts)
    return !this.index || seqId === undefined ? 0 : this.index.lineCount(seqId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    const seqId = await this.getSeqId(seqName)
    return !this.index || seqId === undefined
      ? []
      : this.index.indexCov(seqId, start, end)
  }

  async blocksForRange(
    seqName: string,
    start: number,
    end: number,
    opts?: BaseOpts,
  ) {
    const seqId = await this.getSeqId(seqName, opts)
    return !this.index || seqId === undefined
      ? []
      : this.index.blocksForRange(seqId, start, end, opts)
  }

  clearFeatureCache() {
    this.chunkFeatureCache.clear()
  }

  async estimatedBytesForRegions(
    regions: { refName: string; start: number; end: number }[],
    opts?: BaseOpts,
  ) {
    if (!this.index) {
      return 0
    }
    await this.getHeader(opts)
    const mapped = regions.flatMap(r => {
      const refId = this.chrToIndex?.[r.refName]
      return refId === undefined ? [] : [{ refId, start: r.start, end: r.end }]
    })
    return this.index.estimatedBytesForRegions(mapped, opts)
  }
}
