import AbortablePromiseCache from 'abortable-promise-cache'
import QuickLRU from 'quick-lru'
import { GenericFilehandle } from 'generic-filehandle'
import VirtualOffset from './virtualOffset'
import Chunk from './chunk'

export interface Props {
  signal?: AbortSignal
  statusCallback?: Function
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
    this._parseCache = new AbortablePromiseCache({
      cache: new QuickLRU({ maxSize: 1 }),
      fill: (data: any, props: Props) => {
        console.log('console.log', this._parse)
        console.log('2', data)
        console.log('3', props)
        return this._parse(data)
      },
    })
  }
  public abstract async lineCount(refId: number, props: Props): Promise<number>

  protected abstract async _parse(props: Props): Promise<any>

  public abstract async indexCov(
    query: { seqId: number; start?: number; end?: number },
    props: Props,
  ): Promise<{ start: number; end: number; score: number }[]>

  public abstract async blocksForRange(
    chrId: number,
    start: number,
    end: number,
    opts: Props,
  ): Promise<Chunk[]>

  _findFirstData(data: any, virtualOffset: VirtualOffset) {
    const currentFdl = data.firstDataLine
    if (currentFdl) {
      data.firstDataLine =
        currentFdl.compareTo(virtualOffset) > 0 ? virtualOffset : currentFdl
    } else {
      data.firstDataLine = virtualOffset
    }
  }

  parse(props: Props = {}) {
    console.log('HERE', props)
    return this._parseCache.get('index', props, props.signal)
  }

  /**
   * @param {number} seqId
   * @param {AbortSignal} [signal]
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasRefSeq(seqId: number, props: Props) {
    return !!((await this.parse(props)).indices[seqId] || {}).binIndex
  }
}
