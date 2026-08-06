import { SharedReadCache } from '@gmod/shared-read-cache'
import QuickLRU from '@jbrowse/quick-lru'

import { chunksLikelyRead, optimizeChunks } from './util.ts'

import type Chunk from './chunk.ts'
import type { BaseOpts } from './util.ts'
import type { OffsetCoords, VirtualOffset } from './virtualOffset.ts'
import type { GenericFilehandle } from 'generic-filehandle2'

export interface Region {
  refId: number
  start: number
  end: number
}

export interface RefIndex {
  binIndex: Record<number, Chunk[]>
  stats?: { lineCount: number }
}

export interface ParsedIndexBase<R extends RefIndex = RefIndex> {
  firstDataLine: VirtualOffset | undefined
  refCount: number
  indices: (refId: number) => R | undefined
}

// SYNC: ~/src/gmod/tabix-js/src/util.ts memoizeByRefId
// LRU-cache the result of getIndices(refId) so repeated lookups for the same
// reference don't re-walk the index bytes.
export function memoizeByRefId<T>(
  getIndices: (refId: number) => T | undefined,
  maxSize = 5,
) {
  const cache = new QuickLRU<number, T>({ maxSize })
  return (refId: number) => {
    // one lookup, not has()+get(): only truthy results are ever cached, so a
    // miss and a cached value are already distinguishable
    const cached = cache.get(refId)
    if (cached !== undefined) {
      return cached
    }
    const result = getIndices(refId)
    if (result) {
      cache.set(refId, result)
    }
    return result
  }
}

export default abstract class IndexFile<
  TParsed extends ParsedIndexBase = ParsedIndexBase,
> {
  public filehandle: GenericFilehandle
  public renameRefSeq: (s: string) => string

  /**
   * The parsed index, as a shared read — see {@link parse}. One entry, never
   * evicted, which is what a memo is.
   */
  private parseCache = new SharedReadCache<string, TParsed>({})

  constructor({
    filehandle,
    renameRefSeq = (n: string) => n,
  }: {
    filehandle: GenericFilehandle
    renameRefSeq?: (a: string) => string
  }) {
    this.filehandle = filehandle
    this.renameRefSeq = renameRefSeq
  }

  protected abstract _parse(opts: BaseOpts): Promise<TParsed>

  public abstract indexCov(
    refId: number,
    start?: number,
    end?: number,
  ): Promise<{ start: number; end: number; score: number }[]>

  // Bin numbers that overlap [min, max). Subclasses implement BAI's fixed
  // 5-level scheme or CSI's configurable scheme (SAMv1.pdf §5.1.1, CSIv1.tex §2).
  protected abstract reg2bins(
    min: number,
    max: number,
  ): readonly (readonly [number, number])[]

  // Lower-bound virtual offset for chunks that could contain alignments in
  // [min, ...). BAI uses its linear index; CSI has none and returns 0:0.
  protected abstract getLowestChunk(
    refIndex: RefIndex,
    min: number,
  ): OffsetCoords | undefined

  // Block position past which a chunk is EXPECTED to hold nothing overlapping
  // [..., max] — the counterpart of getLowestChunk, and unlike it an estimate
  // rather than a bound (see chunksLikelyRead). Only `estimatedBytesForRegions`
  // may use it. CSI has no linear index and returns undefined, which reads as
  // "no opinion" and leaves that estimate summing every chunk.
  protected abstract getHighestChunk(
    refIndex: RefIndex,
    max: number,
  ): number | undefined

  async blocksForRange(
    refId: number,
    min: number,
    max: number,
    opts: BaseOpts = {},
  ): Promise<Chunk[]> {
    if (min < 0) {
      min = 0
    }
    const indexData = await this.parse(opts)
    const ba = indexData.indices(refId)
    if (!ba) {
      return []
    }
    const overlappingBins = this.reg2bins(min, max)
    if (overlappingBins.length === 0) {
      return []
    }
    const chunks: Chunk[] = []
    const { binIndex } = ba
    for (const [start, end] of overlappingBins) {
      for (let bin = start; bin <= end; bin++) {
        const binChunks = binIndex[bin]
        if (binChunks) {
          for (let i = 0, l = binChunks.length; i < l; i++) {
            chunks.push(binChunks[i]!)
          }
        }
      }
    }
    return optimizeChunks(chunks, this.getLowestChunk(ba, min))
  }

  // SYNC: ~/src/gmod/tabix-js/src/indexFile.ts parse — same shape and the same
  // reasoning below.
  /**
   * Parse the index, or join the parse already running.
   *
   * The index is downloaded and parsed once for the life of this object, so it
   * is the one read here that is shared between queries — and therefore the one
   * place a cancellation can leak from the query that asked for it to a query
   * that did not. `_parse` hands `opts` straight to `filehandle.readFile`, so a
   * bare memoized promise makes the first query to arrive the owner of a read
   * every other query depends on: when it pans away, every concurrent query
   * fails with its abort.
   *
   * The same cache the chunk reads use, for the same reason and with the same
   * rule: the parse runs under a signal of its own and is cancelled only once
   * every caller waiting on it has given up, so one query's abort is reported
   * to that query alone. A rejection is dropped rather than cached, so a
   * transient failure does not poison the index for the life of the file.
   *
   * The fill is per call rather than on the cache so that the caller who starts
   * the parse has its `onProgress` reach `filehandle.readFile` — the index is a
   * whole-file read, and a determinate "downloading index" bar is what that
   * callback exists for.
   */
  parse(opts: BaseOpts = {}): Promise<TParsed> {
    return this.parseCache.get('index', opts.signal, signal =>
      this._parse({ ...opts, signal }),
    )
  }

  async lineCount(refId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return indexData.indices(refId)?.stats?.lineCount ?? 0
  }

  async hasRefSeq(seqId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return !!indexData.indices(seqId)
  }

  /**
   * Compressed bytes a `getRecordsForRange` over these regions is expected to
   * download, from the index alone.
   *
   * Per region this is `chunksLikelyRead`, not every chunk `blocksForRange`
   * returns: the difference is the whole point on a long-read file, where a
   * narrow window inherits every chunk of every overlapping bin and reads a
   * handful of them. Measured on a 40x ONT BAM (COLO829BL, chr3), summing all
   * chunks against the bytes the same query really pulls:
   *
   * | window | all chunks | actually read | this estimate |
   * | ------ | ---------- | ------------- | ------------- |
   * | 380bp  | 43.5MB     | 7.8MB         | 7.8MB         |
   * | 3.4kb  | 43.5MB     | 7.8MB         | 7.8MB         |
   * | 100kb  | 46.6MB     | 10.4MB        | 10.4MB        |
   * | 2Mb    | 155.9MB    | 155.9MB       | 123.8MB       |
   *
   * A caller gating on this — jbrowse's "too much data" banner is the one that
   * exists — was being told 5.6x the truth on exactly the windows a reader
   * spends their time in, and cannot answer it by zooming: every window narrower
   * than a linear-index interval resolves to the same chunks and so to the same
   * number.
   *
   * Still summed over merged chunks rather than per region, so two regions
   * sharing a chunk are charged for it once.
   */
  async estimatedBytesForRegions(regions: Region[], opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    const blockResults = await Promise.all(
      regions.map(async r => {
        const chunks = await this.blocksForRange(r.refId, r.start, r.end, opts)
        const refIndex = indexData.indices(r.refId)
        return refIndex
          ? chunksLikelyRead(chunks, this.getHighestChunk(refIndex, r.end))
          : chunks
      }),
    )

    // Deduplicate and merge overlapping blocks across all regions
    const mergedBlocks = optimizeChunks(blockResults.flat())

    let total = 0
    for (const block of mergedBlocks) {
      total += block.fetchedSize()
    }
    return total
  }
}
