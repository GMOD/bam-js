import QuickLRU from '@jbrowse/quick-lru'

import { optimizeChunks } from './util.ts'

import type Chunk from './chunk.ts'
import type { BaseOpts } from './util.ts'
import type { VirtualOffset } from './virtualOffset.ts'
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

  public abstract blocksForRange(
    chrId: number,
    start: number,
    end: number,
    opts?: BaseOpts,
  ): Promise<Chunk[]>

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
    return indexData.indices(refId)?.stats?.lineCount || 0
  }

  async hasRefSeq(seqId: number, opts?: BaseOpts) {
    const indexData = await this.parse(opts)
    return !!indexData.indices(seqId)?.binIndex
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
