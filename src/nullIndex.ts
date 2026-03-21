import type Chunk from './chunk'

import IndexFile from './indexFile'

export default class NullIndex extends IndexFile {
  public lineCount(): Promise<number> {
    throw new Error('never called')
  }

  public async indexCov(): Promise<
    { start: number; end: number; score: number }[]
  > {
    throw new Error('never called')
  }

  public blocksForRange(): Promise<Chunk[]> {
    throw new Error('never called')
  }
}
