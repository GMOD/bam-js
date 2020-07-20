import AbortablePromiseCache from 'abortable-promise-cache'
import QuickLRU from 'quick-lru'
import { GenericFilehandle } from 'generic-filehandle'
import VirtualOffset from './virtualOffset'
import Chunk from './chunk'
export interface BaseOpts {
  signal?: AbortSignal
}
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
  protected abstract async _parse(opts?: BaseOpts): Promise<any>
  public abstract async indexCov(
    refId: number,
    start?: number,
    end?: number,
  ): Promise<{ start: number; end: number; score: number }[]>
  public abstract async blocksForRange(
    chrId: number,
    start: number,
    end: number,
    opts: BaseOpts,
  ): Promise<Chunk[]>

  _findFirstData(data: any, virtualOffset: VirtualOffset) {
    const currentFdl = data.firstDataLine
    if (currentFdl) {
      data.firstDataLine = currentFdl.compareTo(virtualOffset) > 0 ? virtualOffset : currentFdl
    } else {
      data.firstDataLine = virtualOffset
    }
  }

  async parse(opts: BaseOpts = {}) {
    if (!this._parseCache) {
      this._parseCache = new AbortablePromiseCache({
        cache: new QuickLRU({ maxSize: 1 }),
        fill: (opts: BaseOpts, signal?: AbortSignal) => {
          return this._parse({ ...opts, signal })
        },
      })
    }
    return this._parseCache.get('index', opts, opts.signal)
  }

  async hasRefSeq(seqId: number, opts: BaseOpts = {}) {
    return !!((await this.parse(opts)).indices[seqId] || {}).binIndex
  }
}
