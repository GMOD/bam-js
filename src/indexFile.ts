import Chunk from './chunk.ts'
import { BaseOpts } from './util.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

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
}
