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
  public cache = new QuickLRU<string, { buffer: Uint8Array; nextIn: number }>({
    maxSize: 1000,
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
      return
    }
    const indexData = await this.index.parse(opts)
    const ret = indexData.firstDataLine
      ? indexData.firstDataLine.blockPosition + 65535
      : undefined
    let buffer
    if (ret) {
      const s = ret + blockLen
      buffer = await this.bam.read(s, 0)
    } else {
      buffer = await this.bam.readFile(opts)
    }

    const uncba = await unzip(buffer)
    const dataView = new DataView(uncba.buffer)

    if (dataView.getInt32(0, true) !== BAM_MAGIC) {
      throw new Error('Not a BAM file')
    }
    const headLen = dataView.getInt32(4, true)

    const decoder = new TextDecoder('utf8')
    this.header = decoder.decode(uncba.subarray(8, 8 + headLen))
    const { chrToIndex, indexToChr } = await this._readRefSeqs(
      headLen + 8,
      65535,
      opts,
    )
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

  // the full length of the refseq block is not given in advance so this grabs
  // a chunk and doubles it if all refseqs haven't been processed
  async _readRefSeqs(
    start: number,
    refSeqBytes: number,
    opts?: BaseOpts,
  ): Promise<{
    chrToIndex: Record<string, number>
    indexToChr: { refName: string; length: number }[]
  }> {
    if (start > refSeqBytes) {
      return this._readRefSeqs(start, refSeqBytes * 2, opts)
    }
    // const size = refSeqBytes + blockLen <-- use this?
    const buffer = await this.bam.read(refSeqBytes, 0, opts)
    const uncba = await unzip(buffer)
    const dataView = new DataView(uncba.buffer)
    const nRef = dataView.getInt32(start, true)
    let p = start + 4
    const chrToIndex: Record<string, number> = {}
    const indexToChr: { refName: string; length: number }[] = []
    const decoder = new TextDecoder('utf8')
    for (let i = 0; i < nRef; i += 1) {
      const lName = dataView.getInt32(p, true)
      const refName = this.renameRefSeq(
        decoder.decode(uncba.subarray(p + 4, p + 4 + lName - 1)),
      )
      const lRef = dataView.getInt32(p + lName + 4, true)

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
      yield []
    } else {
      const chunks = await this.index.blocksForRange(chrId, min - 1, max, opts)
      yield* this._fetchChunkFeatures(chunks, chrId, min, max, opts)
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

    for (const chunk of chunks) {
      const { data, cpositions, dpositions } = await this._readChunk({
        chunk,
        opts,
      })
      const records = await this.readBamFeatures(
        data,
        cpositions,
        dpositions,
        chunk,
      )

      const recs = [] as BAMFeature[]
      for (const feature of records) {
        if (feature.ref_id === chrId) {
          if (feature.start >= max) {
            // past end of range, can stop iterating
            done = true
            break
          } else if (feature.end >= min) {
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

      // increment position to the current decompressed status
      if (hasDpositions) {
        while (blockStart + chunk.minv.dataPosition >= dpositions[pos++]!) {}
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
          // the below results in an automatically calculated file-offset based
          // ID if the info for that is available, otherwise crc32 of the
          // features
          //
          // cpositions[pos] refers to actual file offset of a bgzip block
          // boundaries
          //
          // we multiply by (1 <<8) in order to make sure each block has a
          // "unique" address space so that data in that block could never
          // overlap
          //
          // then the blockStart-dpositions is an uncompressed file offset from
          // that bgzip block boundary, and since the cpositions are multiplied
          // by (1 << 8) these uncompressed offsets get a unique space
          //
          // this has an extra chunk.minv.dataPosition added on because it
          // blockStart starts at 0 instead of chunk.minv.dataPosition
          //
          // the +1 is just to avoid any possible uniqueId 0 but this does not
          // realistically happen
          fileOffset: hasCpositions
            ? cpositions[pos]! * (1 << 8) +
              (blockStart - dpositions[pos]!) +
              chunk.minv.dataPosition +
              1
            : // this shift >>> 0 is equivalent to crc32(b).unsigned but uses the
              // internal calculator of crc32 to avoid accidentally importing buffer
              // https://github.com/alexgorbatchev/crc/blob/31fc3853e417b5fb5ec83335428805842575f699/src/define_crc.ts#L5
              crc32(ba.subarray(blockStart, blockEnd)) >>> 0,
        })

        sink.push(feature)
      }

      blockStart = blockEnd + 1
    }
    return sink
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
}
