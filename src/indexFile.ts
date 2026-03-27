import Chunk from './chunk.ts'
import { BaseOpts, optimizeChunks } from './util.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

export interface Region {
  refId: number
  start: number
  end: number
}

export default abstract class IndexFile {
  public filehandle: GenericFilehandle
  public renameRefSeq: (s: string) => string

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
  public abstract lineCount(refId: number): Promise<number>
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
