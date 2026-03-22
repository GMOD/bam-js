import IndexFile from './indexFile.ts'

export default class NullIndex extends IndexFile {
  public lineCount(): Promise<never> {
    throw new Error('never called')
  }
  protected _parse(): Promise<never> {
    throw new Error('never called')
  }

  public indexCov(): Promise<never> {
    throw new Error('never called')
  }

  public blocksForRange(): Promise<never> {
    throw new Error('never called')
  }
}
