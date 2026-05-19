import QuickLRU from '@jbrowse/quick-lru'

import { optimizeChunks } from './util.ts'

import type Chunk from './chunk.ts'
import type { BaseOpts } from './util.ts'
import type { Offset, VirtualOffset } from './virtualOffset.ts'
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
  maxBlockSize: number
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
    if (cache.has(refId)) {
      return cache.get(refId)
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

  private setupP?: Promise<TParsed>

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
  ): Offset | undefined

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

  parse(opts: BaseOpts = {}): Promise<TParsed> {
    if (!this.setupP) {
      this.setupP = this._parse(opts).catch((e: unknown) => {
        this.setupP = undefined
        throw e
      })
    }
    return this.setupP
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
