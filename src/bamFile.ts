import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import QuickLRU from '@jbrowse/quick-lru'
import crc32 from 'crc/calculators/crc32'
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import BAI from './bai.ts'
import Chunk from './chunk.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import {
  filterCacheKey,
  filterReadFlag,
  filterTagValue,
  makeOpts,
} from './util.ts'

import type { Bytes } from './record.ts'
import type { BamOpts, BaseOpts, FilterBy } from './util.ts'
import type { GenericFilehandle } from 'generic-filehandle2'

export interface BamRecordLike {
  ref_id: number
  start: number
  end: number
  name: string
  fileOffset: number
  next_pos: number
  next_refid: number
  flags: number
  tags: Record<string, unknown>
}

export type BamRecordClass<T extends BamRecordLike = BAMFeature> = new (args: {
  bytes: Bytes
  fileOffset: number
}) => T

export const BAM_MAGIC = 21840194

const blockLen = 1 << 16

interface ChunkEntry<T> {
  minBlock: number
  maxBlock: number
  features: T[]
}

export default class BamFile<T extends BamRecordLike = BAMFeature> {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
  private fallbackIndex?: BAI | CSI
  private indexResolved = false
  private indexResolvePromise?: Promise<void>
  public htsget = false
  public headerP?: ReturnType<BamFile<T>['getHeaderPre']>

  // Cache for parsed features by chunk
  // When a new chunk overlaps a cached chunk, we evict the cached one
  public chunkFeatureCache = new QuickLRU<string, ChunkEntry<T>>({
    maxSize: 100,
  })

  private RecordClass: BamRecordClass<T>

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
    recordClass,
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
    recordClass?: BamRecordClass<T>
  }) {
    this.renameRefSeq = renameRefSeqs
    this.RecordClass = (recordClass ?? BAMFeature) as BamRecordClass<T>

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
    if (baiFilehandle && csiFilehandle) {
      this.index = new BAI({ filehandle: baiFilehandle })
      this.fallbackIndex = new CSI({ filehandle: csiFilehandle })
    } else if (csiFilehandle) {
      this.index = new CSI({ filehandle: csiFilehandle })
    } else if (baiFilehandle) {
      this.index = new BAI({ filehandle: baiFilehandle })
    } else if (baiPath && csiPath) {
      this.index = new BAI({ filehandle: new LocalFile(baiPath) })
      this.fallbackIndex = new CSI({ filehandle: new LocalFile(csiPath) })
    } else if (csiPath) {
      this.index = new CSI({ filehandle: new LocalFile(csiPath) })
    } else if (baiPath) {
      this.index = new BAI({ filehandle: new LocalFile(baiPath) })
    } else if (baiUrl && csiUrl) {
      this.index = new BAI({ filehandle: new RemoteFile(baiUrl) })
      this.fallbackIndex = new CSI({ filehandle: new RemoteFile(csiUrl) })
    } else if (csiUrl) {
      this.index = new CSI({ filehandle: new RemoteFile(csiUrl) })
    } else if (baiUrl) {
      this.index = new BAI({ filehandle: new RemoteFile(baiUrl) })
    } else if (bamPath) {
      this.index = new BAI({ filehandle: new LocalFile(`${bamPath}.bai`) })
      this.fallbackIndex = new CSI({ filehandle: new LocalFile(`${bamPath}.csi`) })
    } else if (bamUrl) {
      this.index = new BAI({ filehandle: new RemoteFile(`${bamUrl}.bai`) })
      this.fallbackIndex = new CSI({ filehandle: new RemoteFile(`${bamUrl}.csi`) })
    } else if (htsget) {
      this.htsget = true
    } else {
      throw new Error('unable to infer index format')
    }
  }

  private async ensureIndex(opts?: BaseOpts) {
    if (this.indexResolved) {
      return
    }
    if (!this.indexResolvePromise) {
      this.indexResolvePromise = this.resolveIndex(opts)
    }
    return this.indexResolvePromise
  }

  private async resolveIndex(opts?: BaseOpts) {
    if (!this.fallbackIndex || !this.index) {
      this.indexResolved = true
      return
    }
    try {
      await this.index.parse(opts)
      this.indexResolved = true
    } catch (e) {
      const isNotFound =
        e instanceof Error &&
        (/HTTP 404/.test(e.message) || /ENOENT/.test(e.message))
      if (isNotFound) {
        this.index = this.fallbackIndex
        this.fallbackIndex = undefined
        this.indexResolved = true
      } else {
        throw e
      }
    }
  }

  async getHeaderPre(origOpts?: BaseOpts) {
    const opts = makeOpts(origOpts)
    if (!this.index) {
      return undefined
    }
    await this.ensureIndex(opts)
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
      indexToChr.push({
        refName,
        length: lRef,
      })

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
    await this.getHeader(opts)
    await this.ensureIndex(opts)
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined || !this.index) {
      return []
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    return this._fetchChunkFeaturesDirect(chunks, chrId, min, max, opts)
  }

  private chunkCacheKey(chunk: Chunk, filterBy?: FilterBy) {
    const { minv, maxv } = chunk
    return `${minv.blockPosition}:${minv.dataPosition}-${maxv.blockPosition}:${maxv.dataPosition}${filterCacheKey(filterBy)}`
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
        this.chunkFeatureCache.delete(key)
      }
    }
  }

  private async _fetchChunkFeaturesDirect(
    chunks: Chunk[],
    chrId: number,
    min: number,
    max: number,
    opts: BamOpts = {},
  ) {
    const { viewAsPairs, filterBy } = opts
    const { flagInclude = 0, flagExclude = 0, tagFilter } = filterBy || {}
    const result: T[] = []

    for (let ci = 0, cl = chunks.length; ci < cl; ci++) {
      const chunk = chunks[ci]!
      const cacheKey = this.chunkCacheKey(chunk, filterBy)
      const minBlock = chunk.minv.blockPosition
      const maxBlock = chunk.maxv.blockPosition

      let records: T[]
      const cached = this.chunkFeatureCache.get(cacheKey)
      if (cached) {
        records = cached.features
      } else {
        this.evictOverlappingChunks(minBlock, maxBlock)
        const { data, cpositions, dpositions } = await this._readChunk({
          chunk,
          opts,
        })
        const allRecords = await this.readBamFeatures(
          data,
          cpositions,
          dpositions,
          chunk,
        )
        if (filterBy) {
          records = []
          for (let i = 0, l = allRecords.length; i < l; i++) {
            const record = allRecords[i]!
            if (filterReadFlag(record.flags, flagInclude, flagExclude)) {
              continue
            }
            if (
              tagFilter &&
              filterTagValue(record.tags[tagFilter.tag], tagFilter.value)
            ) {
              continue
            }
            records.push(record)
          }
        } else {
          records = allRecords
        }
        this.chunkFeatureCache.set(cacheKey, {
          minBlock,
          maxBlock,
          features: records,
        })
      }

      let done = false
      for (let i = 0, l = records.length; i < l; i++) {
        const feature = records[i]!
        if (feature.ref_id === chrId) {
          if (feature.start >= max) {
            done = true
            break
          } else if (feature.end >= min) {
            result.push(feature)
          }
        }
      }
      if (done) {
        break
      }
    }

    if (viewAsPairs) {
      const pairs = await this.fetchPairs(chrId, result, opts)
      for (let i = 0, l = pairs.length; i < l; i++) {
        result.push(pairs[i]!)
      }
    }

    return result
  }

  async fetchPairs(chrId: number, records: T[], opts: BamOpts) {
    await this.ensureIndex(opts)
    const { pairAcrossChr, maxInsertSize = 200000 } = opts
    const readNameCounts: Record<string, number> = {}
    const readIds: Record<number, number> = {}

    for (let i = 0, l = records.length; i < l; i++) {
      const r = records[i]!
      const name = r.name
      readNameCounts[name] = (readNameCounts[name] || 0) + 1
      readIds[r.fileOffset] = 1
    }

    const matePromises: Promise<Chunk[]>[] = []
    for (let i = 0, l = records.length; i < l; i++) {
      const f = records[i]!
      const name = f.name
      if (
        this.index &&
        readNameCounts[name] === 1 &&
        (pairAcrossChr ||
          (f.next_refid === chrId &&
            Math.abs(f.start - f.next_pos) < maxInsertSize))
      ) {
        matePromises.push(
          this.index.blocksForRange(
            f.next_refid,
            f.next_pos,
            f.next_pos + 1,
            opts,
          ),
        )
      }
    }

    const map = new Map<string, Chunk>()
    const res = await Promise.all(matePromises)
    for (let i = 0, l = res.length; i < l; i++) {
      const chunks = res[i]!
      for (let j = 0, jl = chunks.length; j < jl; j++) {
        const m = chunks[j]!
        const key = m.toString()
        if (!map.has(key)) {
          map.set(key, m)
        }
      }
    }

    const mateFeatPromises = await Promise.all(
      [...map.values()].map(async c => {
        const { data, cpositions, dpositions, chunk } = await this._readChunk({
          chunk: c,
          opts,
        })
        const mateRecs = [] as T[]
        const features = await this.readBamFeatures(
          data,
          cpositions,
          dpositions,
          chunk,
        )
        for (let i = 0, l = features.length; i < l; i++) {
          const feature = features[i]!
          if (
            readNameCounts[feature.name] === 1 &&
            !readIds[feature.fileOffset]
          ) {
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
    } = await unzipChunkSlice(buf, chunk)
    return { data, cpositions, dpositions, chunk }
  }

  async readBamFeatures(
    ba: Uint8Array,
    cpositions: number[],
    dpositions: number[],
    chunk: Chunk,
  ) {
    let blockStart = 0
    const sink = [] as T[]
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
        const feature = new this.RecordClass({
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

  async hasRefSeq(seqName: string) {
    await this.ensureIndex()
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined ? false : this.index?.hasRefSeq(seqId)
  }

  async lineCount(seqName: string) {
    await this.ensureIndex()
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined || !this.index ? 0 : this.index.lineCount(seqId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    if (!this.index) {
      return []
    }
    await this.ensureIndex()
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
    await this.ensureIndex(opts)
    await this.index.parse()
    const seqId = this.chrToIndex?.[seqName]
    return seqId === undefined
      ? []
      : this.index.blocksForRange(seqId, start, end, opts)
  }

  clearFeatureCache() {
    this.chunkFeatureCache.clear()
  }

  async estimatedBytesForRegions(
    regions: { refName: string; start: number; end: number }[],
    opts?: BaseOpts,
  ) {
    if (!this.index) {
      return 0
    }
    await this.ensureIndex(opts)
    await this.getHeader(opts)
    if (!this.chrToIndex) {
      throw new Error('Header not yet parsed')
    }
    return this.index.estimatedBytesForRegions(
      regions.map(r => {
        const refId = this.chrToIndex![r.refName]
        if (refId === undefined) {
          throw new Error(`Unknown reference name: ${r.refName}`)
        }
        return {
          refId,
          start: r.start,
          end: r.end,
        }
      }),
      opts,
    )
  }
}
