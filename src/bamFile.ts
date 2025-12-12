import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import crc32 from 'crc/calculators/crc32'
import { LocalFile, RemoteFile } from 'generic-filehandle2'
import QuickLRU from 'quick-lru'

import BAI from './bai.ts'
import Chunk from './chunk.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import { gen2array, makeOpts } from './util.ts'

import type { BamOpts, BaseOpts } from './util.ts'
import type { GenericFilehandle } from 'generic-filehandle2'

export const BAM_MAGIC = 21840194

const blockLen = 1 << 16

export default class BamFile {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
  public htsget = false
  public headerP?: ReturnType<BamFile['getHeaderPre']>
  public cache = new QuickLRU<
    string,
    { bytesRead: number; buffer: Uint8Array; nextIn: number }
  >({
    maxSize: 1000,
  })

  // Cache for parsed features by chunk
  // When a new chunk overlaps a cached chunk, we evict the cached one
  public chunkFeatureCache = new QuickLRU<
    string,
    { minBlock: number; maxBlock: number; features: BAMFeature[] }
  >({ maxSize: 100 })

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
    renameRefSeqs?: (a: string) => string
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
    } else {
      throw new Error('unable to infer index format')
    }
  }

  async getHeaderPre(origOpts?: BaseOpts) {
    const opts = makeOpts(origOpts)
    if (!this.index) {
      return undefined
    }
    const indexData = await this.index.parse(opts)

    // firstDataLine is not defined in cases where there is no data in the file
    // (just bam header and nothing else)
    const buffer =
      indexData.firstDataLine === undefined
        ? await this.bam.readFile()
        : // the logic indexData.firstDataLine is a virtualOffset telling us
          // where the data is. It is in the middle of a virtualOffset
          // (provided by the bgzip block offset at blockPosition + the
          // virtualOffset dataPosition, so we add one extra blockLen to make
          // sure we consume the full header)
          await this.bam.read(
            indexData.firstDataLine.blockPosition + blockLen,
            0,
          )
    const uncba = await unzip(buffer)
    const dataView = new DataView(uncba.buffer)

    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)
    const decoder = new TextDecoder('utf8')
    this.header = decoder.decode(uncba.subarray(8, 8 + headLen))

    const { chrToIndex, indexToChr } = this._parseRefSeqs(uncba, headLen + 8)
    this.chrToIndex = chrToIndex
    this.indexToChr = indexToChr
    return parseHeaderText(this.header)
  }

  getHeader(opts?: BaseOpts) {
    if (!this.headerP) {
      this.headerP = this.getHeaderPre(opts).catch((e: unknown) => {
        this.headerP = undefined
        throw e
      })
    }
    return this.headerP
  }

  async getHeaderText(opts: BaseOpts = {}) {
    await this.getHeader(opts)
    return this.header
  }

  _parseRefSeqs(
    uncba: Uint8Array,
    start: number,
  ): {
    chrToIndex: Record<string, number>
    indexToChr: { refName: string; length: number }[]
  } {
    const dataView = new DataView(uncba.buffer)
    const nRef = dataView.getInt32(start, true)
    let p = start + 4

    const chrToIndex: Record<string, number> = {}
    const indexToChr: { refName: string; length: number }[] = []
    const decoder = new TextDecoder('utf8')

    for (let i = 0; i < nRef; i += 1) {
      if (p + 8 > uncba.length) {
        throw new Error(
          `Insufficient data for reference sequences: need more than ${uncba.length} bytes`,
        )
      }

      const lName = dataView.getInt32(p, true)
      const refName = this.renameRefSeq(
        decoder.decode(uncba.subarray(p + 4, p + 4 + lName - 1)),
      )
      const lRef = dataView.getInt32(p + lName + 4, true)

      chrToIndex[refName] = i
      indexToChr.push({ refName, length: lRef })

      p = p + 8 + lName
    }

    return { chrToIndex, indexToChr }
  }

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    return gen2array(this.streamRecordsForRange(chr, min, max, opts))
  }

  async *streamRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    await this.getHeader(opts)
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined || !this.index) {
      return
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    yield* this._fetchChunkFeatures(chunks, chrId, min, max, opts)
  }

  private chunkCacheKey(chunk: Chunk) {
    const { minv, maxv } = chunk
    return `${minv.blockPosition}:${minv.dataPosition}-${maxv.blockPosition}:${maxv.dataPosition}`
  }

  private blocksOverlap(
    minBlock1: number,
    maxBlock1: number,
    minBlock2: number,
    maxBlock2: number,
  ) {
    return minBlock1 <= maxBlock2 && maxBlock1 >= minBlock2
  }

  // Evict any cached chunks that overlap with the given block range
  private evictOverlappingChunks(minBlock: number, maxBlock: number) {
    for (const [key, entry] of this.chunkFeatureCache) {
      if (
        this.blocksOverlap(minBlock, maxBlock, entry.minBlock, entry.maxBlock)
      ) {
        // console.log(
        //   `[BAM Cache] Evicting overlapping chunk: ${key} (${entry.features.length} features, blocks ${entry.minBlock}-${entry.maxBlock})`,
        // )
        this.chunkFeatureCache.delete(key)
      }
    }
  }

  async *_fetchChunkFeatures(
    chunks: Chunk[],
    chrId: number,
    min: number,
    max: number,
    opts: BamOpts = {},
  ) {
    const { viewAsPairs } = opts
    const feats = [] as BAMFeature[][]
    let done = false
    // let cacheHits = 0
    // let cacheMisses = 0

    for (const chunk of chunks) {
      const cacheKey = this.chunkCacheKey(chunk)
      const minBlock = chunk.minv.blockPosition
      const maxBlock = chunk.maxv.blockPosition

      let records: BAMFeature[]
      const cached = this.chunkFeatureCache.get(cacheKey)
      if (cached) {
        records = cached.features
        // cacheHits++
      } else {
        this.evictOverlappingChunks(minBlock, maxBlock)
        const { data, cpositions, dpositions } = await this._readChunk({
          chunk,
          opts,
        })
        records = await this.readBamFeatures(
          data,
          cpositions,
          dpositions,
          chunk,
        )
        this.chunkFeatureCache.set(cacheKey, {
          minBlock,
          maxBlock,
          features: records,
        })
        // cacheMisses++
      }

      const recs = [] as BAMFeature[]
      for (const feature of records) {
        if (feature.ref_id === chrId) {
          if (feature.start >= max) {
            done = true
            break
          } else if (feature.end >= min) {
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

    // const total = cacheHits + cacheMisses
    // if (total > 0) {
    //   const hitRate = (cacheHits / total) * 100
    //   console.log(
    //     `[BAM Cache] chunks: ${total}, hits: ${cacheHits}, misses: ${cacheMisses}, rate: ${hitRate.toFixed(1)}%, cacheSize: ${this.chunkFeatureCache.size}`,
    //   )
    // }

    if (viewAsPairs) {
      yield this.fetchPairs(chrId, feats, opts)
    }
  }

  async fetchPairs(chrId: number, feats: BAMFeature[][], opts: BamOpts) {
    const { pairAcrossChr, maxInsertSize = 200000 } = opts
    const unmatedPairs: Record<string, boolean> = {}
    const readIds: Record<string, number> = {}
    for (const ret of feats) {
      const readNames: Record<string, number> = {}
      for (const element of ret) {
        const name = element.name
        const id = element.id
        if (!readNames[name]) {
          readNames[name] = 0
        }
        readNames[name]++
        readIds[id] = 1
      }
      for (const [k, v] of Object.entries(readNames)) {
        if (v === 1) {
          unmatedPairs[k] = true
        }
      }
    }

    const matePromises: Promise<Chunk[]>[] = []
    for (const ret of feats) {
      for (const f of ret) {
        const name = f.name
        const start = f.start
        const pnext = f.next_pos
        const rnext = f.next_refid
        if (
          this.index &&
          unmatedPairs[name] &&
          (pairAcrossChr ||
            (rnext === chrId && Math.abs(start - pnext) < maxInsertSize))
        ) {
          matePromises.push(
            this.index.blocksForRange(rnext, pnext, pnext + 1, opts),
          )
        }
      }
    }

    // filter out duplicate chunks (the blocks are lists of chunks, blocks are
    // concatenated, then filter dup chunks)
    const map = new Map<string, Chunk>()
    const res = await Promise.all(matePromises)
    for (const m of res.flat()) {
      if (!map.has(m.toString())) {
        map.set(m.toString(), m)
      }
    }

    const mateFeatPromises = await Promise.all(
      [...map.values()].map(async c => {
        const { data, cpositions, dpositions, chunk } = await this._readChunk({
          chunk: c,
          opts,
        })
        const mateRecs = [] as BAMFeature[]
        for (const feature of await this.readBamFeatures(
          data,
          cpositions,
          dpositions,
          chunk,
        )) {
          if (unmatedPairs[feature.name] && !readIds[feature.id]) {
            mateRecs.push(feature)
          }
        }
        return mateRecs
      }),
    )
    return mateFeatPromises.flat()
  }

  async _readChunk({ chunk, opts }: { chunk: Chunk; opts: BaseOpts }) {
    const buf = await this.bam.read(
      chunk.fetchedSize(),
      chunk.minv.blockPosition,
      opts,
    )

    const {
      buffer: data,
      cpositions,
      dpositions,
    } = await unzipChunkSlice(buf, chunk, this.cache)
    return { data, cpositions, dpositions, chunk }
  }

  async readBamFeatures(
    ba: Uint8Array,
    cpositions: number[],
    dpositions: number[],
    chunk: Chunk,
  ) {
    let blockStart = 0
    const sink = [] as BAMFeature[]
    let pos = 0

    const dataView = new DataView(ba.buffer)
    const hasDpositions = dpositions.length > 0
    const hasCpositions = cpositions.length > 0

    while (blockStart + 4 < ba.length) {
      const blockSize = dataView.getInt32(blockStart, true)
      const blockEnd = blockStart + 4 + blockSize - 1

      if (hasDpositions) {
        while (blockStart + chunk.minv.dataPosition >= dpositions[pos++]!) {}
        pos--
      }

      if (blockEnd < ba.length) {
        const feature = new BAMFeature({
          bytes: {
            byteArray: ba,
            start: blockStart,
            end: blockEnd,
          },
          fileOffset: hasCpositions
            ? cpositions[pos]! * (1 << 8) +
              (blockStart - dpositions[pos]!) +
              chunk.minv.dataPosition +
              1
            : crc32(ba.subarray(blockStart, blockEnd)) >>> 0,
        })

        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  _shouldIncludeFeature(
    dataView: DataView,
    blockStart: number,
    chrId: number,
    max: number,
  ) {
    const ref_id = dataView.getInt32(blockStart + 4, true)
    const start = dataView.getInt32(blockStart + 8, true)
    return ref_id === chrId && start < max
  }

  async hasRefSeq(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined ? false : this.index?.hasRefSeq(seqId)
  }

  async lineCount(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined || !this.index ? 0 : this.index.lineCount(seqId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    if (!this.index) {
      return []
    }
    await this.index.parse()
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined ? [] : this.index.indexCov(seqId, start, end)
  }

  async blocksForRange(
    seqName: string,
    start: number,
    end: number,
    opts?: BaseOpts,
  ) {
    if (!this.index) {
      return []
    }
    await this.index.parse()
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined
      ? []
      : this.index.blocksForRange(seqId, start, end, opts)
  }

  clearFeatureCache() {
    this.chunkFeatureCache.clear()
  }
}
