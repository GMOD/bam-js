import AbortablePromiseCache from 'abortable-promise-cache'
import QuickLRU from 'quick-lru'
import { GenericFilehandle } from 'generic-filehandle'
import VirtualOffset from './virtualOffset'
import Chunk from './chunk'

export default abstract class IndexFile {
  public filehandle: GenericFilehandle
  public renameRefSeq: Function
  private _parseCache: any

  /**
   * @param {filehandle} filehandle
   * @param {function} [renameRefSeqs]
   */
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
  public abstract async lineCount(refId: number): Promise<number>
  protected abstract async _parse(signal?: AbortSignal): Promise<any>
  public abstract async indexCov(
    refId: number,
    start?: number,
    end?: number,
  ): Promise<{ start: number; end: number; score: number }[]>
  public abstract async blocksForRange(
    chrId: number,
    start: number,
    end: number,
    opts: Record<string, any>,
  ): Promise<Chunk[]>

  _findFirstData(data: any, virtualOffset: VirtualOffset) {
    const currentFdl = data.firstDataLine
    if (currentFdl) {
      data.firstDataLine = currentFdl.compareTo(virtualOffset) > 0 ? virtualOffset : currentFdl
    } else {
      data.firstDataLine = virtualOffset
    }
  }

  async parse(abortSignal?: AbortSignal) {
    if (!this._parseCache)
      this._parseCache = new AbortablePromiseCache({
        cache: new QuickLRU({ maxSize: 1 }),
        fill: (data: any, signal: AbortSignal) => this._parse(signal),
      })
    return this._parseCache.get('index', null, abortSignal)
  }

  /**
   * @param {number} seqId
   * @param {AbortSignal} [abortSignal]
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasRefSeq(seqId: number, abortSignal?: AbortSignal) {
    return !!((await this.parse(abortSignal)).indices[seqId] || {}).binIndex
  }
}
