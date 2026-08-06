import QuickLRU from '@jbrowse/quick-lru'

import { optimizeChunks, throwIfAborted } from './util.ts'

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

  private parseP?: Promise<TParsed>
  /**
   * The signal `parseP` was started under, while it is still in flight. The
   * index is parsed once and shared by every query against the file, so without
   * this the first query to arrive would own a read all the others depend on —
   * see {@link parse}.
   */
  private parseSignal?: AbortSignal

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

  // SYNC: ~/src/gmod/tabix-js/src/indexFile.ts parse — same owner-signal
  // tracking and one-attempt retry, and the same reasoning below.
  /**
   * Parse the index, or join the parse already running.
   *
   * The index is downloaded and parsed once for the life of this object, so it
   * is the one read here that is shared between queries — and therefore the one
   * place a cancellation can leak from the query that asked for it to a query
   * that did not. `_parse` hands `opts` straight to `filehandle.readFile`, so
   * without this the first query to arrive owns a read every other query
   * depends on: when it pans away, every concurrent query fails with its abort.
   *
   * A caller that joined someone else's parse and saw it fail because *they*
   * aborted starts over rather than inheriting the failure — once, then
   * propagates. Bounding it at one attempt is what jbrowse's
   * `RemoteFileWithRangeCache.joinChunk` does with the same retry one layer
   * down, and for the reason it gives: the pathological case becomes one
   * duplicate parse rather than a recursion whose depth depends on how the
   * aborts interleave.
   *
   * A retry rather than the reference count `_cachedChunkFeatures` uses, for
   * the reason `@gmod/cram` gives for the same split in `CraiIndex`: the index
   * is parsed once for the life of the object, so there is no repeated waste to
   * recover, and this is a dozen lines against restructuring the memo.
   */
  async parse(opts: BaseOpts = {}, retried = false): Promise<TParsed> {
    throwIfAborted(opts.signal)
    const pending = this.parseP
    if (!pending) {
      return this.startParse(opts)
    }

    // read before awaiting: the owner is forgotten as soon as the parse settles
    const ownerSignal = this.parseSignal
    try {
      return await pending
    } catch (e) {
      if (retried || !ownerSignal?.aborted || opts.signal?.aborted) {
        throw e
      }
      return this.parse(opts, true)
    }
  }

  private startParse(opts: BaseOpts) {
    const pending = this._parse(opts)
    this.parseP = pending
    this.parseSignal = opts.signal
    // Drop a rejection rather than keeping it, so one transient failure does not
    // poison the index for the lifetime of the file. Both branches are
    // identity-checked so a retry started after this settles is not cleared by
    // the attempt it already replaced.
    pending.then(
      () => {
        if (this.parseP === pending) {
          this.parseSignal = undefined
        }
      },
      () => {
        if (this.parseP === pending) {
          this.parseP = undefined
          this.parseSignal = undefined
        }
      },
    )
    return pending
  }

  async lineCount(refId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return indexData.indices(refId)?.stats?.lineCount ?? 0
  }

  async hasRefSeq(seqId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return !!indexData.indices(seqId)
  }

  async estimatedBytesForRegions(regions: Region[], opts?: BaseOpts) {
    const blockResults = await Promise.all(
      regions.map(r => this.blocksForRange(r.refId, r.start, r.end, opts)),
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
