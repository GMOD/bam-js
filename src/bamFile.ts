import { ByteCache, decompressChunkCached, unzip } from '@gmod/bgzf-filehandle'
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import BAI from './bai.ts'
import BlockFeatureCache from './blockFeatureCache.ts'
import Chunk from './chunk.ts'
import CSI from './csi.ts'
import NullFilehandle from './nullFilehandle.ts'
import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import { filterReadFlag, filterTagValue, makeOpts } from './util.ts'

import type { Bytes } from './record.ts'
import type { BamOpts, BaseOpts } from './util.ts'
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

export default class BamFile<T extends BamRecordLike = BAMFeature> {
  public renameRefSeq: (a: string) => string
  public bam: GenericFilehandle
  public header?: string
  public chrToIndex?: Record<string, number>
  public indexToChr?: { refName: string; length: number }[]
  public index?: BAI | CSI
  public htsget = false
  public headerP?: ReturnType<BamFile<T>['getHeaderPre']>

  // LRU cache for decompressed BGZF block bytes
  public byteCache = new ByteCache()

  // LRU cache for parsed features by block position
  public featureCache = new BlockFeatureCache<T>()

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
    const chrId = this.chrToIndex?.[chr]
    if (chrId === undefined || !this.index) {
      return []
    }
    const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
    return this._fetchChunkFeaturesDirect(chunks, chrId, min, max, opts)
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
      const { minv } = chunk

      // Decompress chunk using byte cache
      const { buffer, cpositions, dpositions } = await decompressChunkCached(
        this.bam,
        chunk,
        this.byteCache,
        opts,
      )

      const dataView = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      )
      let done = false

      // Process each block in the chunk, using feature cache where possible
      for (let blockIdx = 0; blockIdx < cpositions.length; blockIdx++) {
        if (done) {
          break
        }

        const blockPosition = cpositions[blockIdx]!
        const blockStart = dpositions[blockIdx]!
        const blockEnd =
          blockIdx + 1 < dpositions.length
            ? dpositions[blockIdx + 1]!
            : buffer.length

        // Determine start offset within this block
        let startOffset = blockStart
        if (blockIdx === 0) {
          // First block: start from minv.dataPosition
          startOffset = blockStart + minv.dataPosition
        } else {
          // Subsequent blocks: check if we need to skip bytes from spanning record
          const prevBlockPos = cpositions[blockIdx - 1]!
          const prevCacheEntry = this.featureCache.get(prevBlockPos)
          if (prevCacheEntry && prevCacheEntry.nextBlockSkipBytes > 0) {
            startOffset = blockStart + prevCacheEntry.nextBlockSkipBytes
          }
        }

        // Check feature cache for this block
        const cachedEntry = this.featureCache.get(blockPosition)
        if (cachedEntry) {
          // Use cached features
          for (let i = 0, l = cachedEntry.features.length; i < l; i++) {
            const feature = cachedEntry.features[i]!
            if (filterBy) {
              if (filterReadFlag(feature.flags, flagInclude, flagExclude)) {
                continue
              }
              if (
                tagFilter &&
                filterTagValue(feature.tags[tagFilter.tag], tagFilter.value)
              ) {
                continue
              }
            }
            if (feature.ref_id === chrId) {
              if (feature.start >= max) {
                done = true
                break
              }
              if (feature.end >= min) {
                result.push(feature)
              }
            }
          }
          continue
        }

        // Parse features for this block
        const blockFeatures: T[] = []
        let offset = startOffset
        let nextBlockSkipBytes = 0

        while (offset + 4 < buffer.length) {
          const recordSize = dataView.getInt32(offset, true)
          if (recordSize < 0) {
            break
          }
          const recordEnd = offset + 4 + recordSize - 1
          if (recordEnd >= buffer.length) {
            break
          }

          // Calculate fileOffset
          let fileOffset = 0
          for (let i = 0; i < dpositions.length; i++) {
            if (offset >= dpositions[i]!) {
              fileOffset =
                cpositions[i]! * (1 << 8) + (offset - dpositions[i]!) + 1
            }
          }

          const feature = new this.RecordClass({
            bytes: {
              byteArray: buffer,
              start: offset,
              end: recordEnd,
            },
            fileOffset,
          })

          // Only include features that START in this block
          if (offset < blockEnd) {
            blockFeatures.push(feature)
          }

          offset = recordEnd + 1

          // If we've crossed into the next block, calculate skip bytes and stop
          if (offset >= blockEnd && blockIdx + 1 < cpositions.length) {
            nextBlockSkipBytes = offset - blockEnd
            break
          }
        }

        // Cache the features for this block
        this.featureCache.set(blockPosition, blockFeatures, nextBlockSkipBytes)

        // Add matching features to result
        for (let i = 0, l = blockFeatures.length; i < l; i++) {
          const feature = blockFeatures[i]!
          if (filterBy) {
            if (filterReadFlag(feature.flags, flagInclude, flagExclude)) {
              continue
            }
            if (
              tagFilter &&
              filterTagValue(feature.tags[tagFilter.tag], tagFilter.value)
            ) {
              continue
            }
          }
          if (feature.ref_id === chrId) {
            if (feature.start >= max) {
              done = true
              break
            }
            if (feature.end >= min) {
              result.push(feature)
            }
          }
        }
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

  // Used by HtsgetFile to parse records from pre-decompressed data
  async readBamFeatures(
    buffer: Uint8Array,
    cpositions: number[],
    dpositions: number[],
    _chunk: Chunk,
  ): Promise<T[]> {
    const dataView = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    )
    const features: T[] = []
    let offset = 0

    while (offset + 4 < buffer.length) {
      const recordSize = dataView.getInt32(offset, true)
      if (recordSize < 0) {
        break
      }
      const recordEnd = offset + 4 + recordSize - 1
      if (recordEnd >= buffer.length) {
        break
      }

      // Calculate fileOffset
      let fileOffset = offset + 1
      if (cpositions.length > 0 && dpositions.length > 0) {
        for (let i = 0; i < dpositions.length; i++) {
          if (offset >= dpositions[i]!) {
            fileOffset =
              cpositions[i]! * (1 << 8) + (offset - dpositions[i]!) + 1
          }
        }
      }

      const feature = new this.RecordClass({
        bytes: {
          byteArray: buffer,
          start: offset,
          end: recordEnd,
        },
        fileOffset,
      })
      features.push(feature)
      offset = recordEnd + 1
    }

    return features
  }

  async fetchPairs(chrId: number, records: T[], opts: BamOpts) {
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
      [...map.values()].map(async chunk => {
        const { minv } = chunk

        // Decompress chunk using byte cache
        const { buffer, cpositions, dpositions } = await decompressChunkCached(
          this.bam,
          chunk,
          this.byteCache,
          opts,
        )

        const dataView = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        )
        const mateRecs: T[] = []

        // Process each block in the chunk, using feature cache where possible
        for (let blockIdx = 0; blockIdx < cpositions.length; blockIdx++) {
          const blockPosition = cpositions[blockIdx]!
          const blockStart = dpositions[blockIdx]!
          const blockEnd =
            blockIdx + 1 < dpositions.length
              ? dpositions[blockIdx + 1]!
              : buffer.length

          // Determine start offset within this block
          let startOffset = blockStart
          if (blockIdx === 0) {
            startOffset = blockStart + minv.dataPosition
          } else {
            const prevBlockPos = cpositions[blockIdx - 1]!
            const prevCacheEntry = this.featureCache.get(prevBlockPos)
            if (prevCacheEntry && prevCacheEntry.nextBlockSkipBytes > 0) {
              startOffset = blockStart + prevCacheEntry.nextBlockSkipBytes
            }
          }

          // Check feature cache for this block
          const cachedEntry = this.featureCache.get(blockPosition)
          if (cachedEntry) {
            for (let i = 0, l = cachedEntry.features.length; i < l; i++) {
              const feature = cachedEntry.features[i]!
              if (
                readNameCounts[feature.name] === 1 &&
                !readIds[feature.fileOffset]
              ) {
                mateRecs.push(feature)
              }
            }
            continue
          }

          // Parse features for this block
          const blockFeatures: T[] = []
          let offset = startOffset
          let nextBlockSkipBytes = 0

          while (offset + 4 < buffer.length) {
            const recordSize = dataView.getInt32(offset, true)
            if (recordSize < 0) {
              break
            }
            const recordEnd = offset + 4 + recordSize - 1
            if (recordEnd >= buffer.length) {
              break
            }

            let fileOffset = 0
            for (let i = 0; i < dpositions.length; i++) {
              if (offset >= dpositions[i]!) {
                fileOffset =
                  cpositions[i]! * (1 << 8) + (offset - dpositions[i]!) + 1
              }
            }

            const feature = new this.RecordClass({
              bytes: {
                byteArray: buffer,
                start: offset,
                end: recordEnd,
              },
              fileOffset,
            })

            if (offset < blockEnd) {
              blockFeatures.push(feature)
            }

            offset = recordEnd + 1

            if (offset >= blockEnd && blockIdx + 1 < cpositions.length) {
              nextBlockSkipBytes = offset - blockEnd
              break
            }
          }

          this.featureCache.set(
            blockPosition,
            blockFeatures,
            nextBlockSkipBytes,
          )

          for (let i = 0, l = blockFeatures.length; i < l; i++) {
            const feature = blockFeatures[i]!
            if (
              readNameCounts[feature.name] === 1 &&
              !readIds[feature.fileOffset]
            ) {
              mateRecs.push(feature)
            }
          }
        }

        return mateRecs
      }),
    )
    return mateFeatPromises.flat()
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

  clearByteCache() {
    this.byteCache.clear()
  }

  clearFeatureCache() {
    this.featureCache.clear()
  }

  clearCache() {
    this.byteCache.clear()
    this.featureCache.clear()
  }

  async estimatedBytesForRegions(
    regions: { refName: string; start: number; end: number }[],
    opts?: BaseOpts,
  ) {
    if (!this.index) {
      return 0
    }
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
