import {
  MAX_BGZF_BLOCK_SIZE,
  scanBgzfBlocks,
  unzip,
} from '@gmod/bgzf-filehandle'

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
import type { BgzfBlockInfo, BgzfWorkerPool } from '@gmod/bgzf-filehandle'
import type { GenericFilehandle } from 'generic-filehandle2'

/** compressed bytes per read; ~15 BGZF blocks, so ~8MB decompressed */
const DEFAULT_WINDOW_SIZE = 1 << 20

/**
 * Window reads in flight at once. Four, matching the browser's per-host
 * connection cap of six with room left for whatever else the page is fetching,
 * and holding 4MB of compressed bytes at the default window size.
 */
const DEFAULT_READ_AHEAD = 4

/**
 * A window's blocks, inflated on the pool when there is one.
 *
 * The pool's own interface is what a window already has to hand: the raw
 * compressed bytes and the {@link scanBgzfBlocks} listing the loop needed
 * anyway to find the window's edge. It splits the blocks across its workers and
 * hands them back individually, which concatenate to exactly what `unzip` of
 * the same range returns — the blocks of a BGZF stream are independent, which
 * is what makes any of this parallel.
 *
 * One block is not worth a round trip, the same threshold `unzipChunkSlice`
 * uses. `pool` being undefined is the ordinary case, not a failure: node has no
 * workers, and `getSharedWorkerPool` resolves to undefined there.
 */
async function inflate(
  compressed: Uint8Array,
  blocks: BgzfBlockInfo[],
  blocksEnd: number,
  pool: BgzfWorkerPool | undefined,
) {
  if (pool && blocks.length > 1) {
    const { blocks: inflated } = await pool.decompressBlocks(compressed, blocks)
    return concatUint8Array(inflated)
  }
  return unzip(compressed.subarray(0, blocksEnd))
}

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
   * Worker pool to inflate each window on, as in {@link BamFile}. Without one
   * the whole walk inflates on the calling thread, which on a large file is
   * long enough to be worth keeping off whichever thread draws — pass
   * `getSharedWorkerPool()` in a browser, or run the stream in a worker.
   *
   * Takes the promise as readily as the pool, since `getSharedWorkerPool()`
   * returns one and awaiting an already-settled promise costs a microtask.
   */
  bgzfWorkerPool?: BgzfWorkerPool | Promise<BgzfWorkerPool | undefined>
  /**
   * How many window reads to keep in flight at once. Defaults to
   * {@link DEFAULT_READ_AHEAD}; 1 issues the next read only once the previous
   * window has been handed to the caller.
   *
   * Depth is the whole point of it. One outstanding read overlaps a round trip
   * with only the CPU spent on the window before it — 8% end to end over a
   * local server with 20ms of latency — because the wait itself is still
   * serial. Several outstanding turn N waits into roughly N/depth.
   *
   * Costs `depth` windows of compressed bytes held at once, and up to
   * `depth - 1` wasted requests at EOF: a read's length is the only thing that
   * says the file has ended, so the reads queued behind the last one have
   * already gone out by the time it lands.
   */
  readAhead?: number
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
  bgzfWorkerPool,
  windowSize = DEFAULT_WINDOW_SIZE,
  readAhead = DEFAULT_READ_AHEAD,
}: StreamBamOptions<T>): AsyncGenerator<T[], void, undefined> {
  const bam = resolveFilehandle(bamFilehandle, bamPath, bamUrl)
  if (!bam) {
    throw new Error('no bam source: pass bamFilehandle, bamPath, or bamUrl')
  }
  const RecordClass = (recordClass ?? BAMFeature) as BamRecordClass<T>
  const readLen = Math.max(windowSize, MAX_BGZF_BLOCK_SIZE)
  const depth = Math.max(1, Math.floor(readAhead))

  let filePosition = 0
  // trailing bytes of the last window that did not complete a BGZF block, and
  // that did not complete a BAM record, respectively. Both boundaries fall
  // wherever they fall, so each window starts by finishing the last one's
  // remainder.
  let blockCarry: Uint8Array | undefined
  let recordCarry: Uint8Array | undefined
  let sawHeader = false
  // 1-based, as readBamFeatures' virtual-offset ids are
  let recordIndex = 0
  const pool = await bgzfWorkerPool

  // Several windows are in flight at once, consumed in the order they were
  // asked for. Depth is what makes this worth doing: with one read outstanding
  // the wait for a window can only overlap the CPU spent on the window before
  // it, which is a fraction of a round trip — measured at 8% end to end, where
  // depth 4 hides most of the latency instead. See {@link
  // StreamBamOptions.readAhead}.
  const queue: Promise<Uint8Array>[] = []
  let nextReadPosition = 0
  let exhausted = false
  const topUp = () => {
    while (!exhausted && queue.length < depth) {
      queue.push(bam.read(readLen, nextReadPosition, { signal }))
      nextReadPosition += readLen
    }
  }
  // Reads nobody will consume — queued past EOF, or still out when the caller
  // broke out of the loop or a window threw. Each needs its rejection taken,
  // or a failing read that arrives after we have stopped looking surfaces as
  // an unhandled rejection.
  const abandon = () => {
    for (const p of queue.splice(0)) {
      p.catch(() => undefined)
    }
  }

  try {
    topUp()
    while (queue.length > 0) {
      throwIfAborted(signal)
      const read = await queue.shift()!
      filePosition += read.length
      // A short read is the end of the file — the filehandles here return
      // exactly what was asked for until then, and an empty buffer past it.
      // The reads already queued behind it are past EOF; drop them rather than
      // decompressing empty buffers.
      if (read.length < readLen) {
        exhausted = true
        abandon()
      }
      topUp()
      const compressed = blockCarry
        ? concatUint8Array([blockCarry, read])
        : read
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

      const decompressed = await inflate(compressed, blocks, blocksEnd, pool)
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
            // An indexed read derives fileOffset from the record's BGZF virtual
            // offset, which nothing here has: there is no index to seek back
            // with. Its ordinal in the file is the other thing that identifies a
            // record by position, and it is the same for a given file whatever
            // the window size, so it is as stable as a virtual offset without
            // pretending to be one.
            //
            // NOT the crc32 of the record bytes that readBamFeatures falls back
            // to when it has no positions. That is a content hash, so the two
            // byte-identical records in exact_duplicate.bam collide on it, and
            // hashing every record costs ~40% of the walk (135ms of 340ms over
            // out.bam) where a counter costs nothing. The fallback only fires on
            // an unusual path there; here it would fire on every record.
            recordIndex++,
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
    }
  } finally {
    abandon()
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
