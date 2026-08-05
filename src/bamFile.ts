import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import crc32 from 'crc/calculators/crc32'
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import BAI from './bai.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import { appendInRange, parseRefSeqs } from './util.ts'

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

interface InFlightChunk<T> {
  promise: Promise<ChunkEntry<T>>
  // Signals of the callers still waiting on this read. The read is cancelled
  // only once every one of them has given up — see joinChunkRead and ADR 0007.
  signals: Set<AbortSignal>
  // true once a caller joins without a signal, which pins the read
  pinned: boolean
  // aborts when every caller has given up. what the read actually runs under
  controller: AbortController
  // aborted to take this read's listeners back off its callers' signals
  dispose: AbortController
  settled: boolean
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
// caching one entry pins that whole buffer — 8MB apiece on the nanopore and
// 2kb-read test files, and optimizeChunks merges spans up to 5MB *compressed*,
// so tens of MB is possible. A count-based LRU therefore gives no bound on
// memory at all, which is why this budgets by decompressed bytes instead. It is
// the *only* bound: a query keeps every chunk it parsed, since a chunk dropped
// here costs a re-download and re-decompress the next time the view moves.
export const DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024

// How many of a query's chunks to read at once. Six is the HTTP/1.1
// per-host connection cap browsers enforce, so going much above it buys
// nothing on the transport that matters and only widens peak memory.
const MAX_CONCURRENT_CHUNK_READS = 6

class ChunkFeatureCache<T> {
  private _maxBytes: number
  private entries = new Map<string, ChunkEntry<T>>()
  private bytes = 0

  constructor(maxBytes: number) {
    this._maxBytes = maxBytes
  }

  get maxBytes() {
    return this._maxBytes
  }

  // Accessor rather than a plain field so lowering the budget frees memory now.
  // As a field, a caller trimming the cache under memory pressure got nothing
  // back until the next chunk read happened to call set().
  set maxBytes(maxBytes: number) {
    this._maxBytes = maxBytes
    this.evict()
  }

  get size() {
    return this.entries.size
  }

  get byteSize() {
    return this.bytes
  }

  get(key: string) {
    const entry = this.entries.get(key)
    if (entry) {
      // re-insert so Map iteration order stays least-recently-used first
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  set(key: string, entry: ChunkEntry<T>) {
    this.delete(key)
    this.entries.set(key, entry)
    this.bytes += entry.bytes
    this.evict()
  }

  // Evict from the least-recently-used end. The size > 1 guard means a single
  // chunk larger than the whole budget is still kept: the caller needs it for
  // the query in flight, and dropping it would only force a re-decompress.
  private evict() {
    const lru = this.entries.keys()
    while (this.bytes > this._maxBytes && this.entries.size > 1) {
      this.delete(lru.next().value!)
    }
  }

  delete(key: string) {
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]()
  }
}

export default class BamFile<T extends BamRecordLike = BAMFeature> {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
  public htsget = false
  public headerP?: ReturnType<BamFile<T>['getHeaderPre']>

  // Cache for parsed features by chunk, bounded by decompressed bytes
  public chunkFeatureCache: ChunkFeatureCache<T>

  // Chunks currently being read, so concurrent queries share one decompress
  // instead of racing. Entries live only until the read settles; the resolved
  // features land in chunkFeatureCache.
  private inFlightChunks = new Map<string, InFlightChunk<T>>()

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
    /** budget for the parsed-chunk cache, in decompressed bytes */
    maxCacheBytes?: number
  }) {
    this.renameRefSeq = renameRefSeqs
    this.RecordClass = (recordClass ?? BAMFeature) as BamRecordClass<T>
    this.chunkFeatureCache = new ChunkFeatureCache<T>(maxCacheBytes)

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

  getHeader(opts?: BaseOpts) {
    if (!this.headerP) {
      this.headerP = this.getHeaderPre(opts).catch((e: unknown) => {
        this.headerP = undefined
        throw e
      })
    }
    return this.headerP
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
    opts?.signal?.throwIfAborted()
    const chrId = await this.getSeqId(chr, opts)
    if (chrId === undefined || !this.index) {
      return []
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    return this._fetchChunkFeatures(chunks, chrId, min, max, opts)
  }

  // Read a chunk, publish it to the cache, and keep the in-flight promise
  // discoverable while it runs.
  //
  // The read runs under this entry's own controller rather than any one
  // caller's signal, because the read is shared: it must survive until every
  // caller waiting on it has given up. joinChunkRead is what registers them.
  private _startChunkRead(cacheKey: string, chunk: Chunk) {
    const controller = new AbortController()
    const promise = this._readChunkFeatures(chunk, {
      signal: controller.signal,
    }).then(entry => {
      this.chunkFeatureCache.set(cacheKey, entry)
      return entry
    })
    const inFlight: InFlightChunk<T> = {
      promise,
      signals: new Set(),
      pinned: false,
      controller,
      dispose: new AbortController(),
      settled: false,
    }
    this.inFlightChunks.set(cacheKey, inFlight)
    // `.then(f, f)` rather than `.finally(f)` so the handler's own promise never
    // carries an unhandled rejection.
    const clear = () => {
      inFlight.settled = true
      // nothing reads these once the read has settled, and holding them would
      // pin each caller's AbortController behind this entry
      inFlight.dispose.abort()
      inFlight.signals.clear()
      // only clear our own entry: a later read for this chunk may have replaced it
      if (this.inFlightChunks.get(cacheKey) === inFlight) {
        this.inFlightChunks.delete(cacheKey)
      }
    }
    promise.then(clear, clear)
    return inFlight
  }

  // Register a caller's interest, so the read survives until that caller has
  // given up too.
  //
  // A caller with no signal cannot give up, so it pins the read: there is no
  // longer any set of aborts that should stop it. That is the honest reading of
  // a caller that never asked to be cancellable, and it means one signal-free
  // query makes that chunk's read uncancellable for everyone joined to it.
  //
  // PRECONDITION: `signal` has not aborted yet. `_cachedChunkFeatures` throws
  // first, which is what guarantees it. Registering an already-aborted signal
  // would pin the read forever — `addEventListener` never fires on one, so
  // nothing would ever take it back out of `signals`, the count would never
  // reach zero, and the read would be uncancellable for everyone joined to it.
  // Cancellation would degrade silently: no error, no failing test.
  private joinChunkRead(inFlight: InFlightChunk<T>, signal?: AbortSignal) {
    if (signal === undefined) {
      inFlight.pinned = true
    } else if (!inFlight.signals.has(signal)) {
      // guarded so one signal joining twice — a viewAsPairs query reaching the
      // same chunk for a read and for its mate — does not add two listeners
      inFlight.signals.add(signal)
      signal.addEventListener(
        'abort',
        () => {
          inFlight.signals.delete(signal)
          if (!inFlight.pinned && inFlight.signals.size === 0) {
            inFlight.controller.abort(signal.reason)
          }
        },
        // `once` covers the abort firing; `dispose` covers it never firing
        { once: true, signal: inFlight.dispose.signal },
      )
    }
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
    // Before anything else, including the cache hit. A caller reaches here with
    // a signal that has already fired on the ordinary pan — the abort lands
    // while blocksForRange is still reading the index, and nothing between
    // there and here looks at it, since bai.ts and csi.ts never read the
    // signal. Such a caller must not start a read it has no interest in, and
    // must not be registered as a waiter on someone else's: see joinChunkRead.
    // @gmod/cram checks in exactly this position, in SliceRecordCache.getOrFill.
    opts.signal?.throwIfAborted()

    const cacheKey = chunkCacheKey(chunk)
    const cached = this.chunkFeatureCache.get(cacheKey)
    if (cached) {
      return cached.features
    }

    // Join a read already running for this chunk rather than decompressing it a
    // second time. jbrowse fetches a row of adjacent blocks concurrently and
    // they collapse onto very few chunk keys, so without this a query pays for
    // the same inflate several times over — the dominant cost of a cold query
    // (ADR 0003).
    let pending = this.inFlightChunks.get(cacheKey)
    // A read every caller has abandoned is on its way out but may not have
    // noticed yet. Start a fresh one rather than joining one already doomed.
    if (pending?.controller.signal.aborted && !pending.settled) {
      if (this.inFlightChunks.get(cacheKey) === pending) {
        this.inFlightChunks.delete(cacheKey)
      }
      pending = undefined
    }
    pending ??= this._startChunkRead(cacheKey, chunk)
    // Only a read still running has anything to cancel. Joining a settled one
    // would add this caller to a set nothing will ever take it out of, since
    // the entry drops its abort listeners when it settles.
    if (!pending.settled) {
      this.joinChunkRead(pending, opts.signal)
    }

    try {
      const entry = await pending.promise
      // the read finished, but this caller gave up while waiting for it
      opts.signal?.throwIfAborted()
      return entry.features
    } catch (e) {
      // Prefer this caller's own cancellation to whatever the shared read
      // reported. If we asked to stop, that is the answer we want — and when
      // the read itself was cancelled it is because we, and everyone else,
      // asked it to.
      opts.signal?.throwIfAborted()
      throw e
    }
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
