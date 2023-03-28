import crc32 from 'buffer-crc32'
import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import { LocalFile, RemoteFile, GenericFilehandle } from 'generic-filehandle'
import AbortablePromiseCache from 'abortable-promise-cache'
import QuickLRU from 'quick-lru'
//locals
import BAI from './bai'
import CSI from './csi'
import Chunk from './chunk'
import BAMFeature from './record'
import IndexFile from './indexFile'
import { parseHeaderText } from './sam'
import { checkAbortSignal, timeout, makeOpts, BamOpts, BaseOpts } from './util'
import NullIndex from './nullIndex'

export const BAM_MAGIC = 21840194

const blockLen = 1 << 16

async function gen2array<T>(gen: AsyncIterable<T[]>): Promise<T[]> {
  let out: T[] = []
  for await (const x of gen) {
    out = out.concat(x)
  }
  return out
}

interface Args {
  chunk: Chunk
  opts: BaseOpts
}

class NullFilehandle {
  public read(): Promise<any> {
    throw new Error('never called')
  }
  public stat(): Promise<any> {
    throw new Error('never called')
  }

  public readFile(): Promise<any> {
    throw new Error('never called')
  }

  public close(): Promise<any> {
    throw new Error('never called')
  }
}
export default class BamFile {
  private renameRefSeq: (a: string) => string
  private bam: GenericFilehandle
  private chunkSizeLimit: number
  private fetchSizeLimit: number
  private header?: string
  protected chrToIndex?: Record<string, number>
  protected indexToChr?: { refName: string; length: number }[]
  private yieldThreadTime: number
  public index: IndexFile
  public htsget = false

  private featureCache = new AbortablePromiseCache<Args, BAMFeature[]>({
    cache: new QuickLRU({
      maxSize: 50,
    }),
    fill: async (args: Args, signal) => {
      const { chunk, opts } = args
      const { data, cpositions, dpositions } = await this._readChunk({
        chunk,
        opts: { ...opts, signal },
      })
      return this.readBamFeatures(data, cpositions, dpositions, chunk)
    },
  })

  constructor({
    bamFilehandle,
    bamPath,
    bamUrl,
    baiPath,
    baiFilehandle,
    baiUrl,
    csiPath,
    csiFilehandle,
    csiUrl,
    htsget,
    fetchSizeLimit = 500_000_000,
    chunkSizeLimit = 300_000_000,
    yieldThreadTime = 100,
    renameRefSeqs = n => n,
  }: {
    bamFilehandle?: GenericFilehandle
    bamPath?: string
    bamUrl?: string
    baiPath?: string
    baiFilehandle?: GenericFilehandle
    baiUrl?: string
    csiPath?: string
    csiFilehandle?: GenericFilehandle
    csiUrl?: string
    fetchSizeLimit?: number
    chunkSizeLimit?: number
    renameRefSeqs?: (a: string) => string
    yieldThreadTime?: number
    htsget?: boolean
  }) {
    this.renameRefSeq = renameRefSeqs

    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    } else if (bamUrl) {
      this.bam = new RemoteFile(bamUrl)
    } else if (htsget) {
      this.htsget = true
      this.bam = new NullFilehandle()
    } else {
      throw new Error('unable to initialize bam')
    }
    if (csiFilehandle) {
      this.index = new CSI({ filehandle: csiFilehandle })
    } else if (csiPath) {
      this.index = new CSI({ filehandle: new LocalFile(csiPath) })
    } else if (csiUrl) {
      this.index = new CSI({ filehandle: new RemoteFile(csiUrl) })
    } else if (baiFilehandle) {
      this.index = new BAI({ filehandle: baiFilehandle })
    } else if (baiPath) {
      this.index = new BAI({ filehandle: new LocalFile(baiPath) })
    } else if (baiUrl) {
      this.index = new BAI({ filehandle: new RemoteFile(baiUrl) })
    } else if (bamPath) {
      this.index = new BAI({ filehandle: new LocalFile(`${bamPath}.bai`) })
    } else if (bamUrl) {
      this.index = new BAI({ filehandle: new RemoteFile(`${bamUrl}.bai`) })
    } else if (htsget) {
      this.htsget = true
      this.index = new NullIndex({} as any)
    } else {
      throw new Error('unable to infer index format')
    }
    this.fetchSizeLimit = fetchSizeLimit
    this.chunkSizeLimit = chunkSizeLimit
    this.yieldThreadTime = yieldThreadTime
  }

  async getHeader(origOpts: AbortSignal | BaseOpts = {}) {
    const opts = makeOpts(origOpts)
    const indexData = await this.index.parse(opts)
    const ret = indexData.firstDataLine
      ? indexData.firstDataLine.blockPosition + 65535
      : undefined
    let buffer
    if (ret) {
      const s = ret + blockLen
      const res = await this.bam.read(Buffer.alloc(s), 0, s, 0, opts)
      if (!res.bytesRead) {
        throw new Error('Error reading header')
      }
      buffer = res.buffer.subarray(0, Math.min(res.bytesRead, ret))
    } else {
      buffer = (await this.bam.readFile(opts)) as Buffer
    }

    const uncba = await unzip(buffer)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = uncba.readInt32LE(4)

    this.header = uncba.toString('utf8', 8, 8 + headLen)
    const { chrToIndex, indexToChr } = await this._readRefSeqs(
      headLen + 8,
      65535,
      opts,
    )
    this.chrToIndex = chrToIndex
    this.indexToChr = indexToChr

    return parseHeaderText(this.header)
  }

  async getHeaderText(opts: BaseOpts = {}) {
    await this.getHeader(opts)
    return this.header
  }

  // the full length of the refseq block is not given in advance so this grabs
  // a chunk and doubles it if all refseqs haven't been processed
  async _readRefSeqs(
    start: number,
    refSeqBytes: number,
    opts: BaseOpts = {},
  ): Promise<{
    chrToIndex: { [key: string]: number }
    indexToChr: { refName: string; length: number }[]
  }> {
    if (start > refSeqBytes) {
      return this._readRefSeqs(start, refSeqBytes * 2, opts)
    }
    const size = refSeqBytes + blockLen
    const { bytesRead, buffer } = await this.bam.read(
      Buffer.alloc(size),
      0,
      refSeqBytes,
      0,
      opts,
    )
    if (!bytesRead) {
      throw new Error('Error reading refseqs from header')
    }
    const uncba = await unzip(
      buffer.subarray(0, Math.min(bytesRead, refSeqBytes)),
    )
    const nRef = uncba.readInt32LE(start)
    let p = start + 4
    const chrToIndex: { [key: string]: number } = {}
    const indexToChr: { refName: string; length: number }[] = []
    for (let i = 0; i < nRef; i += 1) {
      const lName = uncba.readInt32LE(p)
      const refName = this.renameRefSeq(
        uncba.toString('utf8', p + 4, p + 4 + lName - 1),
      )
      const lRef = uncba.readInt32LE(p + lName + 4)

      chrToIndex[refName] = i
      indexToChr.push({ refName, length: lRef })

      p = p + 8 + lName
      if (p > uncba.length) {
        console.warn(
          `BAM header is very big.  Re-fetching ${refSeqBytes} bytes.`,
        )
        return this._readRefSeqs(start, refSeqBytes * 2, opts)
      }
    }
    return { chrToIndex, indexToChr }
  }

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts: BamOpts = {
      viewAsPairs: false,
      pairAcrossChr: false,
      maxInsertSize: 200000,
    },
  ) {
    return gen2array(this.streamRecordsForRange(chr, min, max, opts))
  }

  async *streamRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts: BamOpts = {},
  ) {
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined) {
      yield []
    } else {
      const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)

      for (let i = 0; i < chunks.length; i += 1) {
        const size = chunks[i].fetchedSize()
        if (size > this.chunkSizeLimit) {
          throw new Error(
            `Too many BAM features. BAM chunk size ${size} bytes exceeds chunkSizeLimit of ${this.chunkSizeLimit}`,
          )
        }
      }

      const totalSize = chunks
        .map(s => s.fetchedSize())
        .reduce((a, b) => a + b, 0)
      if (totalSize > this.fetchSizeLimit) {
        throw new Error(
          `data size of ${totalSize.toLocaleString()} bytes exceeded fetch size limit of ${this.fetchSizeLimit.toLocaleString()} bytes`,
        )
      }
      yield* this._fetchChunkFeatures(chunks, chrId, min, max, opts)
    }
  }

  async *_fetchChunkFeatures(
    chunks: Chunk[],
    chrId: number,
    min: number,
    max: number,
    opts: BamOpts,
  ) {
    const { viewAsPairs = false } = opts
    const feats = []
    let done = false

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const records = (await this.featureCache.get(
        c.toString(),
        {
          chunk: c,
          opts,
        },
        opts.signal,
      )) as BAMFeature[]

      const recs = []
      for (let i = 0; i < records.length; i += 1) {
        const feature = records[i]
        if (feature.seq_id() === chrId) {
          if (feature.get('start') >= max) {
            // past end of range, can stop iterating
            done = true
            break
          } else if (feature.get('end') >= min) {
            // must be in range
            recs.push(feature)
          }
        }
      }
      feats.push(recs)
      yield recs
      if (done) {
        break
      }
    }

    checkAbortSignal(opts.signal)
    if (viewAsPairs) {
      yield this.fetchPairs(chrId, feats, opts)
    }
  }

  async fetchPairs(chrId: number, feats: BAMFeature[][], opts: BamOpts) {
    const { pairAcrossChr = false, maxInsertSize = 200000 } = opts
    const unmatedPairs: { [key: string]: boolean } = {}
    const readIds: { [key: string]: number } = {}
    feats.map(ret => {
      const readNames: { [key: string]: number } = {}
      for (let i = 0; i < ret.length; i++) {
        const name = ret[i].name()
        const id = ret[i].id()
        if (!readNames[name]) {
          readNames[name] = 0
        }
        readNames[name]++
        readIds[id] = 1
      }
      Object.entries(readNames).forEach(([k, v]: [string, number]) => {
        if (v === 1) {
          unmatedPairs[k] = true
        }
      })
    })

    const matePromises: Promise<Chunk[]>[] = []
    feats.map(ret => {
      for (let i = 0; i < ret.length; i++) {
        const f = ret[i]
        const name = f.name()
        const start = f.get('start')
        const pnext = f._next_pos()
        const rnext = f._next_refid()
        if (
          unmatedPairs[name] &&
          (pairAcrossChr ||
            (rnext === chrId && Math.abs(start - pnext) < maxInsertSize))
        ) {
          matePromises.push(
            this.index.blocksForRange(rnext, pnext, pnext + 1, opts),
          )
        }
      }
    })

    // filter out duplicate chunks (the blocks are lists of chunks, blocks are
    // concatenated, then filter dup chunks)
    const map = new Map<string, Chunk>()
    const preProcessedMateChunks = (await Promise.all(matePromises)).flat()
    for (const m of preProcessedMateChunks) {
      if (!map.has(m.toString())) {
        map.set(m.toString(), m)
      }
    }
    const mateChunks = [...map.values()]

    const mateTotalSize = mateChunks
      .map(s => s.fetchedSize())
      .reduce((a, b) => a + b, 0)
    if (mateTotalSize > this.fetchSizeLimit) {
      throw new Error(
        `data size of ${mateTotalSize.toLocaleString()} bytes exceeded fetch size limit of ${this.fetchSizeLimit.toLocaleString()} bytes`,
      )
    }
    const mateFeatPromises = mateChunks.map(async c => {
      const { data, cpositions, dpositions, chunk } = await this._readChunk({
        chunk: c,
        opts,
      })
      const feats = await this.readBamFeatures(
        data,
        cpositions,
        dpositions,
        chunk,
      )
      const mateRecs = []
      for (let i = 0; i < feats.length; i += 1) {
        const feature = feats[i]
        if (unmatedPairs[feature.get('name')] && !readIds[feature.id()]) {
          mateRecs.push(feature)
        }
      }
      return mateRecs
    })
    return (await Promise.all(mateFeatPromises)).flat()
  }

  async _readRegion(position: number, size: number, opts: BaseOpts = {}) {
    const { bytesRead, buffer } = await this.bam.read(
      Buffer.alloc(size),
      0,
      size,
      position,
      opts,
    )

    return buffer.subarray(0, Math.min(bytesRead, size))
  }

  async _readChunk({ chunk, opts }: { chunk: Chunk; opts: BaseOpts }) {
    const buffer = await this._readRegion(
      chunk.minv.blockPosition,
      chunk.fetchedSize(),
      opts,
    )

    const {
      buffer: data,
      cpositions,
      dpositions,
    } = await unzipChunkSlice(buffer, chunk)
    return { data, cpositions, dpositions, chunk }
  }

  async readBamFeatures(
    ba: Buffer,
    cpositions: number[],
    dpositions: number[],
    chunk: Chunk,
  ) {
    let blockStart = 0
    const sink = []
    let pos = 0
    let last = +Date.now()

    while (blockStart + 4 < ba.length) {
      const blockSize = ba.readInt32LE(blockStart)
      const blockEnd = blockStart + 4 + blockSize - 1

      // increment position to the current decompressed status
      if (dpositions) {
        while (blockStart + chunk.minv.dataPosition >= dpositions[pos++]) {}
        pos--
      }

      // only try to read the feature if we have all the bytes for it
      if (blockEnd < ba.length) {
        const feature = new BAMFeature({
          bytes: {
            byteArray: ba,
            start: blockStart,
            end: blockEnd,
          },
          // the below results in an automatically calculated file-offset based ID
          // if the info for that is available, otherwise crc32 of the features
          //
          // cpositions[pos] refers to actual file offset of a bgzip block boundaries
          //
          // we multiply by (1 <<8) in order to make sure each block has a "unique"
          // address space so that data in that block could never overlap
          //
          // then the blockStart-dpositions is an uncompressed file offset from
          // that bgzip block boundary, and since the cpositions are multiplied by
          // (1 << 8) these uncompressed offsets get a unique space
          //
          // this has an extra chunk.minv.dataPosition added on because it blockStart
          // starts at 0 instead of chunk.minv.dataPosition
          //
          // the +1 is just to avoid any possible uniqueId 0 but this does not realistically happen
          fileOffset: cpositions.length
            ? cpositions[pos] * (1 << 8) +
              (blockStart - dpositions[pos]) +
              chunk.minv.dataPosition +
              1
            : // must be slice, not subarray for buffer polyfill on web
              crc32.signed(ba.slice(blockStart, blockEnd)),
        })

        sink.push(feature)
        if (this.yieldThreadTime && +Date.now() - last > this.yieldThreadTime) {
          await timeout(1)
          last = +Date.now()
        }
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  async hasRefSeq(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    if (seqId === undefined) {
      return false
    }
    return this.index.hasRefSeq(seqId)
  }

  async lineCount(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    if (seqId === undefined) {
      return 0
    }
    return this.index.lineCount(seqId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    await this.index.parse()
    const seqId = this.chrToIndex?.[seqName]
    if (seqId === undefined) {
      return []
    }
    return this.index.indexCov(seqId, start, end)
  }

  async blocksForRange(
    seqName: string,
    start: number,
    end: number,
    opts?: BaseOpts,
  ) {
    await this.index.parse()
    const seqId = this.chrToIndex?.[seqName]
    if (seqId === undefined) {
      return []
    }
    return this.index.blocksForRange(seqId, start, end, opts)
  }
}
