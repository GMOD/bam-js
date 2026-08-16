import {
  MAX_BGZF_BLOCK_SIZE,
  scanBgzfBlocks,
  unzip,
} from '@gmod/bgzf-filehandle'
import crc32 from 'crc/calculators/crc32'

import BAMFeature from './record.ts'
import { parseHeaderText } from './sam.ts'
import {
  BAM_MAGIC,
  concatUint8Array,
  parseRefSeqs,
  resolveFilehandle,
  throwIfAborted,
} from './util.ts'

import type { BamRecordClass, BamRecordLike } from './bamFile.ts'
import type { GenericFilehandle } from 'generic-filehandle2'

/** compressed bytes per read; ~15 BGZF blocks, so ~8MB decompressed */
const DEFAULT_WINDOW_SIZE = 1 << 20

export interface BamStreamHeader {
  /** the raw SAM header text, i.e. what `samtools view -H` prints */
  headerText: string
  /** the same text parsed into `@HD`/`@SQ`/`@RG`… lines and their tags */
  samHeader: ReturnType<typeof parseHeaderText>
  /** ref name to the `refId` records carry, from the binary ref-seq table */
  chrToIndex: Record<string, number>
  /** the inverse, indexed by `refId` */
  indexToChr: { refName: string; length: number }[]
}

export interface StreamBamOptions<T extends BamRecordLike = BAMFeature> {
  bamFilehandle?: GenericFilehandle
  bamPath?: string
  bamUrl?: string
  recordClass?: BamRecordClass<T>
  renameRefSeqs?: (a: string) => string
  signal?: AbortSignal
  /**
   * Fires once, before the first batch, with everything the ref-seq table and
   * header text hold. A callback rather than a separate call, because the
   * stream has to read the header anyway to find where the records start —
   * making it a method would mean either reading the front of the file twice
   * or holding state between two calls.
   */
  onHeader?: (header: BamStreamHeader) => void
  /**
   * Compressed bytes to read per request. The default reads ~1MB at a time,
   * which is a reasonable HTTP request size and bounds how much sits
   * decompressed at once (~8MB, since BGZF blocks are capped at 64KB and
   * compress ~8x). Values below one maximum-size block are raised to it, since
   * a window that cannot hold a whole block can never make progress.
   */
  windowSize?: number
}

/**
 * Reads every record in a BAM, in file order, without an index.
 *
 * For BAMs that no index can address: unsorted, or name-sorted as they come off
 * the sequencer. {@link BamFile} answers `chr:start-end` by seeking to the
 * chunks an index names, which a file in neither order has none of.
 *
 * Yields records a batch at a time, one batch per window read, rather than one
 * record per `yield`. A whole-file walk over a 1GB BAM is tens of millions of
 * records, and an async generator pays a promise per yield — batching moves
 * that cost to once per few thousand records and lets the caller's inner loop
 * be synchronous:
 *
 * ```js
 * for await (const records of streamBamRecords({ bamPath: 'reads.bam' })) {
 *   for (const record of records) {
 *     // ...
 *   }
 * }
 * ```
 *
 * Deliberately a standalone function and not a `BamFile` method: it shares the
 * record parser and header parser but none of the index, chunk or cache
 * machinery, so a consumer who only streams does not pay for `BAI`/`CSI` in
 * their bundle.
 *
 * Records are views into the window they were decompressed from, as everywhere
 * else in this library. Holding one record from a batch retains that whole
 * window (see {@link StreamBamOptions.windowSize}), so copy out the fields you
 * want rather than keeping a sparse selection of records from a large file.
 */
export async function* streamBamRecords<T extends BamRecordLike = BAMFeature>({
  bamFilehandle,
  bamPath,
  bamUrl,
  recordClass,
  renameRefSeqs = n => n,
  signal,
  onHeader,
  windowSize = DEFAULT_WINDOW_SIZE,
}: StreamBamOptions<T>): AsyncGenerator<T[], void, undefined> {
  const bam = resolveFilehandle(bamFilehandle, bamPath, bamUrl)
  if (!bam) {
    throw new Error('no bam source: pass bamFilehandle, bamPath, or bamUrl')
  }
  const RecordClass = (recordClass ?? BAMFeature) as BamRecordClass<T>
  const readLen = Math.max(windowSize, MAX_BGZF_BLOCK_SIZE)

  let filePosition = 0
  // trailing bytes of the last window that did not complete a BGZF block, and
  // that did not complete a BAM record, respectively. Both boundaries fall
  // wherever they fall, so each window starts by finishing the last one's
  // remainder.
  let blockCarry: Uint8Array | undefined
  let recordCarry: Uint8Array | undefined
  let sawHeader = false

  for (;;) {
    throwIfAborted(signal)
    const read = await bam.read(readLen, filePosition, { signal })
    filePosition += read.length
    const compressed = blockCarry ? concatUint8Array([blockCarry, read]) : read
    if (compressed.length === 0) {
      break
    }

    const blocks = scanBgzfBlocks(compressed, 0, Number.POSITIVE_INFINITY)
    const last = blocks.at(-1)
    if (!last) {
      throw new Error(
        `not a BGZF stream: no valid block at byte ${filePosition - compressed.length}`,
      )
    }
    const blocksEnd = last.inputOffset + last.compressedSize
    // copied, not subarray'd: the remainder is carried across an await, and a
    // view would pin the whole window it came from
    blockCarry =
      blocksEnd < compressed.length ? compressed.slice(blocksEnd) : undefined

    const decompressed = await unzip(compressed.subarray(0, blocksEnd))
    const bytes = recordCarry
      ? concatUint8Array([recordCarry, decompressed])
      : decompressed
    const dataView = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    )

    let blockStart = 0
    if (!sawHeader) {
      if (bytes.length < 8 || dataView.getInt32(0, true) !== BAM_MAGIC) {
        throw new Error('not a BAM file: bad magic')
      }
      const lText = dataView.getInt32(4, true)
      const refs = parseRefSeqs(bytes, 8 + lText, renameRefSeqs)
      if (!refs) {
        // a header with enough contigs to span a window: keep the whole thing
        // and try again with more of it
        recordCarry = bytes
        continue
      }
      const headerText = new TextDecoder('utf8').decode(
        bytes.subarray(8, 8 + lText),
      )
      onHeader?.({
        headerText,
        samHeader: parseHeaderText(headerText),
        chrToIndex: refs.chrToIndex,
        indexToChr: refs.indexToChr,
      })
      sawHeader = true
      blockStart = refs.end
    }

    const sink: T[] = []
    while (blockStart + 4 <= bytes.length) {
      const blockSize = dataView.getInt32(blockStart, true)
      const blockEnd = blockStart + 4 + blockSize - 1
      if (blockEnd >= bytes.length) {
        break
      }
      sink.push(
        new RecordClass(
          bytes,
          blockStart,
          blockEnd,
          // The fileOffset an indexed read derives from BGZF virtual offsets.
          // Nothing here can produce one — there is no index to seek back with
          // — so use the same content hash readBamFeatures falls back to, which
          // at least stays stable across runs.
          crc32(bytes.subarray(blockStart, blockEnd)) >>> 0,
          dataView,
        ),
      )
      blockStart = blockEnd + 1
    }
    recordCarry =
      blockStart < bytes.length ? bytes.slice(blockStart) : undefined

    if (sink.length > 0) {
      yield sink
    }
    if (read.length < readLen) {
      break
    }
  }

  if (!sawHeader) {
    throw new Error('Insufficient data for reference sequences')
  }
  if (blockCarry !== undefined) {
    throw new Error(
      `truncated BAM: ${blockCarry.length} trailing bytes are not a complete BGZF block`,
    )
  }
  if (recordCarry !== undefined) {
    throw new Error(
      `truncated BAM: ${recordCarry.length} bytes left after the last complete record`,
    )
  }
}
