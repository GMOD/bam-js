import { unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import QuickLRU from '@jbrowse/quick-lru'
import crc32 from 'crc/calculators/crc32'
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import BAI from './bai.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import {
  appendInRange,
  applyFilters,
  filterCacheKey,
  parseRefSeqs,
} from './util.ts'

import type Chunk from './chunk.ts'
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
  dataView: DataView
}) => T

export const BAM_MAGIC = 21840194

const blockLen = 1 << 16

function resolveFilehandle(
  filehandle?: GenericFilehandle,
  path?: string,
  url?: string,
) {
  return (
    filehandle ??
    (path ? new LocalFile(path) : url ? new RemoteFile(url) : undefined)
  )
}

interface ChunkEntry<T> {
  minBlock: number
  maxBlock: number
  features: T[]
}

function chunkCacheKey(chunk: Chunk, filterBy?: FilterBy) {
  const { minv, maxv } = chunk
  return `${minv.blockPosition}:${minv.dataPosition}-${maxv.blockPosition}:${maxv.dataPosition}${filterCacheKey(filterBy)}`
}

export default class BamFile<T extends BamRecordLike = BAMFeature> {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
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

    const bamFh = resolveFilehandle(bamFilehandle, bamPath, bamUrl)
    if (bamFh) {
      this.bam = bamFh
    } else if (htsget) {
      this.htsget = true
      this.bam = new NullFilehandle()
    } else {
      throw new Error(
        'no bam source: pass bamFilehandle, bamPath, bamUrl, or htsget: true',
      )
    }

    const csiFh = resolveFilehandle(csiFilehandle, csiPath, csiUrl)
    const baiFh =
      resolveFilehandle(baiFilehandle, baiPath, baiUrl) ??
      resolveFilehandle(
        undefined,
        bamPath ? `${bamPath}.bai` : undefined,
        bamUrl ? `${bamUrl}.bai` : undefined,
      )
    if (csiFh) {
      this.index = new CSI({ filehandle: csiFh })
    } else if (baiFh) {
      this.index = new BAI({ filehandle: baiFh })
    } else if (!htsget) {
      throw new Error(
        'no index source: pass csi*/bai* options or a bamPath/bamUrl so the .bai sibling can be inferred',
      )
    }
    // htsget mode operates without a parsed index
  }

  async getHeaderPre(opts: BaseOpts = {}) {
    if (!this.index) {
      return undefined
    }
    const indexData = await this.index.parse(opts)

    // firstDataLine is not defined in cases where there is no data in the file
    // (just bam header and nothing else)
    const readLen =
      indexData.firstDataLine === undefined
        ? undefined
        : indexData.firstDataLine.blockPosition + blockLen

    const buffer =
      readLen === undefined
        ? await this.bam.readFile()
        : await this.bam.read(readLen, 0)
    let uncba = await unzip(buffer)
    const dataView = new DataView(uncba.buffer)

    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)
    this.header = new TextDecoder('utf8').decode(uncba.subarray(8, 8 + headLen))

    // BAM files with many reference sequences may need more data than the
    // initial read covers. If the first attempt comes up short, fall back to
    // reading the whole file (the index's firstDataLine is just an
    // optimization hint, not a guaranteed cap on the ref-seq table size).
    const refSeqStart = headLen + 8
    let parsed = parseRefSeqs(uncba, refSeqStart, this.renameRefSeq)
    if (!parsed) {
      uncba = await unzip(await this.bam.readFile())
      parsed = parseRefSeqs(uncba, refSeqStart, this.renameRefSeq)
    }
    if (!parsed) {
      throw new Error('Insufficient data for reference sequences')
    }
    this.chrToIndex = parsed.chrToIndex
    this.indexToChr = parsed.indexToChr
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

  async getRecordsForRange(
    chr: string,
    min: number,
    max: number,
    opts?: BamOpts,
  ) {
    await this.getHeader(opts)
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined || !this.index) {
      return []
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    return this._fetchChunkFeaturesDirect(chunks, chrId, min, max, opts)
  }

  // Evict any cached chunks whose block range overlaps [minBlock, maxBlock]
  private evictOverlappingChunks(minBlock: number, maxBlock: number) {
    for (const [key, entry] of this.chunkFeatureCache) {
      if (minBlock <= entry.maxBlock && maxBlock >= entry.minBlock) {
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
    const result: T[] = []

    for (let ci = 0, cl = chunks.length; ci < cl; ci++) {
      const chunk = chunks[ci]!
      const cacheKey = chunkCacheKey(chunk, filterBy)
      const minBlock = chunk.minv.blockPosition
      const maxBlock = chunk.maxv.blockPosition

      let records: T[]
      const cached = this.chunkFeatureCache.get(cacheKey)
      if (cached) {
        records = cached.features
      } else {
        this.evictOverlappingChunks(minBlock, maxBlock)
        const allRecords = await this._readChunkFeatures(chunk, opts)
        records = filterBy ? applyFilters(allRecords, filterBy) : allRecords
        this.chunkFeatureCache.set(cacheKey, {
          minBlock,
          maxBlock,
          features: records,
        })
      }

      appendInRange(records, chrId, min, max, result)
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
    const { pairAcrossChr, maxInsertSize = 200000 } = opts
    const readNameCounts: Record<string, number> = {}
    const readIds = new Set<number>()

    for (let i = 0, l = records.length; i < l; i++) {
      const r = records[i]!
      const name = r.name
      readNameCounts[name] = (readNameCounts[name] ?? 0) + 1
      readIds.add(r.fileOffset)
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
        map.set(m.toString(), m)
      }
    }

    const mateFeatLists = await Promise.all(
      [...map.values()].map(async c => {
        const features = await this._readChunkFeatures(c, opts)
        const mateRecs = [] as T[]
        for (let i = 0, l = features.length; i < l; i++) {
          const feature = features[i]!
          if (
            readNameCounts[feature.name] === 1 &&
            !readIds.has(feature.fileOffset)
          ) {
            mateRecs.push(feature)
          }
        }
        return mateRecs
      }),
    )
    return mateFeatLists.flat()
  }

  async _readChunkFeatures(chunk: Chunk, opts: BaseOpts) {
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
    return this.readBamFeatures(data, cpositions, dpositions, chunk)
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
        const target = blockStart + chunk.minv.dataPosition
        while (pos < dpositions.length && target >= dpositions[pos]!) {
          pos++
        }
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
          dataView,
        })

        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
  }

  async hasRefSeq(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    return !this.index || seqId === undefined
      ? false
      : this.index.hasRefSeq(seqId)
  }

  async lineCount(seqName: string) {
    const seqId = this.chrToIndex?.[seqName]
    return !this.index || seqId === undefined ? 0 : this.index.lineCount(seqId)
  }

  async indexCov(seqName: string, start?: number, end?: number) {
    const seqId = this.chrToIndex?.[seqName]
    return !this.index || seqId === undefined
      ? []
      : this.index.indexCov(seqId, start, end)
  }

  async blocksForRange(
    seqName: string,
    start: number,
    end: number,
    opts?: BaseOpts,
  ) {
    const seqId = this.chrToIndex?.[seqName]
    return !this.index || seqId === undefined
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
    await this.getHeader(opts)
    const chrToIndex = this.chrToIndex
    if (!chrToIndex) {
      throw new Error('Header not yet parsed')
    }
    const mapped = regions.flatMap(r => {
      const refId = chrToIndex[r.refName]
      if (refId === undefined) {
        return []
      }
      return [{ refId, start: r.start, end: r.end }]
    })
    return this.index.estimatedBytesForRegions(mapped, opts)
  }
}
