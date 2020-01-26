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
    this._parseCache = new AbortablePromiseCache({
      cache: new QuickLRU({ maxSize: 1 }),
      fill: (data: any, props: { signal?: AbortSignal; statusCallback?: Function }) => {
        this._parse(props)
      },
    })
  }
  public abstract async lineCount(refId: number): Promise<number>
  protected abstract async _parse(props: { signal?: AbortSignal; statusCallback?: Function }): Promise<any>
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

  async parse(props: { abortSignal?: AbortSignal; statusCallback?: Function }) {
    return this._parseCache.get('index', null, props)
  }

  /**
   * @param {number} seqId
   * @param {AbortSignal} [abortSignal]
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasRefSeq(seqId: number, abortSignal?: AbortSignal) {
    return !!((await this.parse({ abortSignal })).indices[seqId] || {}).binIndex
  }
}
