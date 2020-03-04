import AbortablePromiseCache from 'abortable-promise-cache'
import BAI from './bai'
import CSI from './csi'
import Chunk from './chunk'

import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'

import entries from 'object.entries-ponyfill'
import LRU from 'quick-lru'
import { LocalFile, RemoteFile, GenericFilehandle } from 'generic-filehandle'
import BAMFeature from './record'
import IndexFile from './indexFile'
import { parseHeaderText } from './sam'
import { abortBreakPoint, checkAbortSignal, timeout } from './util'

const BAM_MAGIC = 21840194

const blockLen = 1 << 16
type G = GenericFilehandle

interface BamOpts {
  viewAsPairs?: boolean
  pairAcrossChr?: boolean
  maxInsertSize?: number
  signal?: AbortSignal
}

export default class BamFile {
  private renameRefSeq: (a: string) => string
  private bam: GenericFilehandle
  private index: IndexFile
  private featureCache: any
  private chunkSizeLimit: number
  private fetchSizeLimit: number
  private header: any
  private chrToIndex: any
  private indexToChr: any

  /**
   * @param {object} args
   * @param {string} [args.bamPath]
   * @param {FileHandle} [args.bamFilehandle]
   * @param {string} [args.baiPath]
   * @param {FileHandle} [args.baiFilehandle]
   */
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
    cacheSize,
    fetchSizeLimit,
    chunkSizeLimit,
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
    cacheSize?: number
    fetchSizeLimit?: number
    chunkSizeLimit?: number
    renameRefSeqs?: (a: string) => string
  }) {
    this.renameRefSeq = renameRefSeqs

    if (bamFilehandle) {
      this.bam = bamFilehandle
    } else if (bamPath) {
      this.bam = new LocalFile(bamPath)
    } else if (bamUrl) {
      this.bam = new RemoteFile(bamUrl)
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
    } else {
      throw new Error('unable to infer index format')
    }
    this.featureCache = new AbortablePromiseCache({
      cache: new LRU({
        maxSize: cacheSize !== undefined ? cacheSize : 50,
      }),
      fill: this._readChunk.bind(this),
    })
    this.fetchSizeLimit = fetchSizeLimit || 500000000 // 500MB
    this.chunkSizeLimit = chunkSizeLimit || 300000000 // 300MB
  }

  async getHeader(abortSignal?: AbortSignal) {
    const indexData = await this.index.parse(abortSignal)
    const ret = indexData.firstDataLine ? indexData.firstDataLine.blockPosition + 65535 : undefined
    let buffer
    if (ret) {
      const res = await this.bam.read(Buffer.alloc(ret + blockLen), 0, ret + blockLen, 0, {
        signal: abortSignal,
      })
      const { bytesRead } = res
      ;({ buffer } = res)
      if (!bytesRead) {
        throw new Error('Error reading header')
      }
      if (bytesRead < ret) {
        buffer = buffer.slice(0, bytesRead)
      } else {
        buffer = buffer.slice(0, ret)
      }
    } else {
      buffer = (await this.bam.readFile({ signal: abortSignal })) as Buffer
    }

    const uncba = await unzip(buffer)

    if (uncba.readInt32LE(0) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = uncba.readInt32LE(4)

    this.header = uncba.toString('utf8', 8, 8 + headLen)
    const { chrToIndex, indexToChr } = await this._readRefSeqs(headLen + 8, 65535, abortSignal)
    this.chrToIndex = chrToIndex
    this.indexToChr = indexToChr

    return parseHeaderText(this.header)
  }

  // the full length of the refseq block is not given in advance so this grabs a chunk and
  // doubles it if all refseqs haven't been processed
  async _readRefSeqs(
    start: number,
    refSeqBytes: number,
    abortSignal?: AbortSignal,
  ): Promise<{
    chrToIndex: { [key: string]: number }
    indexToChr: { refName: string; length: number }[]
  }> {
    if (start > refSeqBytes) {
      return this._readRefSeqs(start, refSeqBytes * 2)
    }
    const res = await this.bam.read(Buffer.alloc(refSeqBytes + blockLen), 0, refSeqBytes, 0, {
      signal: abortSignal,
    })
    const { bytesRead } = res
    let { buffer } = res
    if (!bytesRead) {
      throw new Error('Error reading refseqs from header')
    }
    if (bytesRead < refSeqBytes) {
      buffer = buffer.slice(0, bytesRead)
    } else {
      buffer = buffer.slice(0, refSeqBytes)
    }
    const uncba = await unzip(buffer)
    const nRef = uncba.readInt32LE(start)
    let p = start + 4
    const chrToIndex: { [key: string]: number } = {}
    const indexToChr: { refName: string; length: number }[] = []
    for (let i = 0; i < nRef; i += 1) {
      await abortBreakPoint(abortSignal)
      const lName = uncba.readInt32LE(p)
      let refName = uncba.toString('utf8', p + 4, p + 4 + lName - 1)
      refName = this.renameRefSeq(refName)
      const lRef = uncba.readInt32LE(p + lName + 4)

      chrToIndex[refName] = i
      indexToChr.push({ refName, length: lRef })

      p = p + 8 + lName
      if (p > uncba.length) {
        console.warn(`BAM header is very big.  Re-fetching ${refSeqBytes} bytes.`)
        return this._readRefSeqs(start, refSeqBytes * 2)
      }
    }
    return { chrToIndex, indexToChr }
  }

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts: BamOpts = { viewAsPairs: false, pairAcrossChr: false, maxInsertSize: 200000 },
  ) {
    let records: BAMFeature[] = []
    for await (const chunk of this.streamRecordsForRange(chr, min, max, opts)) {
      records = records.concat(chunk)
    }
    return records
  }

  async *streamRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts: BamOpts = { viewAsPairs: false, pairAcrossChr: false, maxInsertSize: 200000 },
  ) {
    // todo regularize refseq names
    opts.viewAsPairs = opts.viewAsPairs || false
    opts.pairAcrossChr = opts.pairAcrossChr || false
    opts.maxInsertSize = opts.maxInsertSize !== undefined ? opts.maxInsertSize : 200000
    const chrId = this.chrToIndex && this.chrToIndex[chr]
    let chunks: Chunk[]
    if (!(chrId >= 0)) {
      chunks = []
    } else {
      chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)

      if (!chunks) {
        throw new Error('Error in index fetch')
      }
    }

    for (let i = 0; i < chunks.length; i += 1) {
      await abortBreakPoint(opts.signal)
      const size = chunks[i].fetchedSize()
      if (size > this.chunkSizeLimit) {
        throw new Error(
          `Too many BAM features. BAM chunk size ${size} bytes exceeds chunkSizeLimit of ${this.chunkSizeLimit}`,
        )
      }
    }

    const totalSize = chunks.map((s: Chunk) => s.fetchedSize()).reduce((a: number, b: number) => a + b, 0)
    if (totalSize > this.fetchSizeLimit) {
      throw new Error(
        `data size of ${totalSize.toLocaleString()} bytes exceeded fetch size limit of ${this.fetchSizeLimit.toLocaleString()} bytes`,
      )
    }
    yield* this._fetchChunkFeatures(chunks, chrId, min, max, opts)
  }

  async *_fetchChunkFeatures(chunks: Chunk[], chrId: number, min: number, max: number, opts: BamOpts) {
    const featPromises = chunks.map(async c => {
      const { data, cpositions, dpositions, chunk } = await this.featureCache.get(c.toString(), c, opts.signal)
      const records = await this.readBamFeatures(data, cpositions, dpositions, chunk)

      const recs = []
      for (let i = 0; i < records.length; i += 1) {
        const feature = records[i]
        if (feature.seq_id() === chrId) {
          if (feature.get('start') >= max) {
            // past end of range, can stop iterating
            break
          } else if (feature.get('end') >= min) {
            // must be in range
            recs.push(feature)
          }
        }
      }
      return recs
    })

    checkAbortSignal(opts.signal)

    for (let i = 0; i < featPromises.length; i++) {
      yield featPromises[i]
    }
    checkAbortSignal(opts.signal)
    if (opts.viewAsPairs) {
      yield this.fetchPairs(chrId, featPromises, opts)
    }
  }

  async fetchPairs(chrId: number, featPromises: Promise<BAMFeature[]>[], opts: BamOpts) {
    const unmatedPairs: { [key: string]: boolean } = {}
    const readIds: { [key: string]: number } = {}
    await Promise.all(
      featPromises.map(async f => {
        const ret = await f
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
        entries(readNames).forEach(([k, v]: [string, number]) => {
          if (v === 1) {
            unmatedPairs[k] = true
          }
        })
      }),
    )

    const matePromises: Promise<Chunk[]>[] = []
    await Promise.all(
      featPromises.map(async f => {
        const ret = await f
        for (let i = 0; i < ret.length; i++) {
          const name = ret[i].name()
          if (
            unmatedPairs[name] &&
            (opts.pairAcrossChr ||
              (ret[i]._next_refid() === chrId &&
                Math.abs(ret[i].get('start') - ret[i]._next_pos()) < (opts.maxInsertSize || 200000)))
          ) {
            matePromises.push(
              this.index.blocksForRange(ret[i]._next_refid(), ret[i]._next_pos(), ret[i]._next_pos() + 1, opts),
            )
          }
        }
      }),
    )

    const mateBlocks = await Promise.all(matePromises)
    let mateChunks: Chunk[] = []
    for (let i = 0; i < mateBlocks.length; i++) {
      mateChunks = mateChunks.concat(mateBlocks[i])
    }
    // filter out duplicate chunks (the blocks are lists of chunks, blocks are concatenated, then filter dup chunks)
    mateChunks = mateChunks.sort().filter((item, pos, ary) => !pos || item.toString() !== ary[pos - 1].toString())

    const mateTotalSize = mateChunks.map(s => s.fetchedSize()).reduce((a, b) => a + b, 0)
    if (mateTotalSize > this.fetchSizeLimit) {
      throw new Error(
        `data size of ${mateTotalSize.toLocaleString()} bytes exceeded fetch size limit of ${this.fetchSizeLimit.toLocaleString()} bytes`,
      )
    }
    const mateFeatPromises = mateChunks.map(async c => {
      const { data, cpositions, dpositions, chunk } = await this.featureCache.get(c.toString(), c, opts.signal)
      const feats = await this.readBamFeatures(data, cpositions, dpositions, chunk)
      const mateRecs = []
      for (let i = 0; i < feats.length; i += 1) {
        const feature = feats[i]
        if (unmatedPairs[feature.get('name')] && !readIds[feature.id()]) {
          mateRecs.push(feature)
        }
      }
      return mateRecs
    })
    const newMateFeats = await Promise.all(mateFeatPromises)
    let featuresRet: BAMFeature[] = []
    if (newMateFeats.length) {
      const newMates = newMateFeats.reduce((result, current) => result.concat(current))
      featuresRet = featuresRet.concat(newMates)
    }
    return featuresRet
  }

  async _readChunk(chunk: Chunk, abortSignal?: AbortSignal) {
    const bufsize = chunk.fetchedSize()
    const res = await this.bam.read(Buffer.alloc(bufsize), 0, bufsize, chunk.minv.blockPosition, {
      signal: abortSignal,
    })
    const { bytesRead } = res
    let { buffer } = res
    checkAbortSignal(abortSignal)
    if (!bytesRead) {
      return []
    }
    if (bytesRead < bufsize) {
      buffer = buffer.slice(0, bytesRead)
    } else {
      buffer = buffer.slice(0, bufsize)
    }

    const { buffer: data, cpositions, dpositions } = await unzipChunkSlice(buffer, chunk)
    checkAbortSignal(abortSignal)
    return { data, cpositions, dpositions, chunk }
  }

  async readBamFeatures(ba: Buffer, cpositions: number[], dpositions: number[], chunk: Chunk) {
    let blockStart = 0
    const sink = []
    let pos = 0
    let featsSinceLastTimeout = 0

    while (blockStart + 4 < ba.length) {
      const blockSize = ba.readInt32LE(blockStart)
      const blockEnd = blockStart + 4 + blockSize - 1

      for (pos = 0; blockStart + chunk.minv.dataPosition >= dpositions[pos]; pos++) {}

      // only try to read the feature if we have all the bytes for it
      if (blockEnd < ba.length) {
        const feature = new BAMFeature({
          bytes: {
            byteArray: ba,
            start: blockStart,
            end: blockEnd,
          },
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
          fileOffset: cpositions[pos] * (1 << 8) + (blockStart - dpositions[pos]) + chunk.minv.dataPosition + 1,
        })

        sink.push(feature)
        featsSinceLastTimeout++
        if (featsSinceLastTimeout > 500) {
          await timeout(1)
          featsSinceLastTimeout = 0
        }
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  async hasRefSeq(seqName: string) {
    const refId = this.chrToIndex && this.chrToIndex[seqName]
    return this.index.hasRefSeq(refId)
  }

  async lineCount(seqName: string) {
    const refId = this.chrToIndex && this.chrToIndex[seqName]
    return this.index.lineCount(refId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    await this.index.parse()
    const seqId = this.chrToIndex && this.chrToIndex[seqName]
    return this.index.indexCov(seqId, start, end)
  }
}
