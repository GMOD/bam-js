import IndexFile from './indexFile'

export default class NullIndex extends IndexFile {
  public lineCount(): Promise<any> {
    throw new Error('never called')
  }
  protected _parse(): Promise<any> {
    throw new Error('never called')
  }

  public async indexCov(): Promise<any> {
    throw new Error('never called')
  }

  public blocksForRange(): Promise<any> {
    throw new Error('never called')
  }
}
