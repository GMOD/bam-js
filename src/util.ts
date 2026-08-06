import Chunk from './chunk.ts'
import { VirtualOffset } from './virtualOffset.ts'

import type { OffsetCoords } from './virtualOffset.ts'

export interface BamOpts {
  viewAsPairs?: boolean
  pairAcrossChr?: boolean
  maxInsertSize?: number
  signal?: AbortSignal
  /**
   * Called as the BGZF blocks covering the query are fetched, with cumulative
   * downloaded bytes and the total to fetch. Reported at block granularity (one
   * tick per chunk, including instant ticks for cache hits) since chunk byte
   * sizes are known up front from the index. Lets callers render a determinate
   * download progress bar.
   */
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void
}

export interface BaseOpts {
  signal?: AbortSignal
  /**
   * Called as the index (.bai/.csi) is downloaded, with cumulative downloaded
   * bytes and the total. The index is a whole-file read, so this streams real
   * byte progress. Lets callers show a determinate "downloading index" bar.
   * (total is optional to match generic-filehandle2's streaming callback.)
   */
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void
}

/**
 * Merge and order the chunks a query resolved to.
 *
 * Takes ownership of `chunks`: with no `lowest` to pre-filter against it sorts
 * the array IN PLACE rather than copying. Every caller builds a fresh array to
 * hand over, which is what makes that safe — passing something you still hold,
 * or anything reachable from the index's per-refId cache, would reorder it
 * underneath you. (The Chunk objects themselves are never mutated; a merged
 * span produces a new instance.)
 */
/**
 * `signal.throwIfAborted()`, without requiring either that method or `reason`.
 *
 * Two reasons not to call the built-in directly. It assumes a *real*
 * `AbortSignal`, and callers pass duck-typed ones — `@gmod/bam`'s
 * `test/csi.test.ts` casts a bare `{ aborted }` through `as AbortSignal`, which
 * is a fair model of what consumers do. Calling a missing method there is a
 * `TypeError` rather than the cancellation the caller asked for, which is a
 * strictly worse failure.
 *
 * And it sets a browser floor. `AbortSignal.prototype.throwIfAborted` and
 * `AbortSignal.reason` are Safari 15.4 / Chrome 100 / Firefox 97 (March 2022),
 * higher than anything else in either dependency tree needs — both packages
 * otherwise touch only `.aborted`, and `generic-filehandle2` only forwards a
 * signal to `fetch`. A few lines here keep that floor where it was.
 *
 * SYNC: @gmod/bam and @gmod/tabix keep identical copies of this.
 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const reason: unknown = signal.reason
    // Spec-faithful: throwIfAborted throws `reason` verbatim, and `reason` is
    // whatever the caller passed to abort() — `controller.abort('too slow')`
    // makes it a string. Coercing it to an Error here would hide that from a
    // consumer who set it deliberately.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw reason === undefined
      ? new DOMException('This operation was aborted', 'AbortError')
      : reason
  }
}

export function optimizeChunks(chunks: Chunk[], lowest?: OffsetCoords) {
  const n = chunks.length
  if (n === 0) {
    return chunks
  }

  // Pre-filter chunks below lowest threshold before sorting
  let filtered: Chunk[]
  if (lowest) {
    const lowestBlock = lowest.blockPosition
    const lowestData = lowest.dataPosition
    filtered = []
    for (let i = 0; i < n; i++) {
      const chunk = chunks[i]!
      const maxv = chunk.maxv
      const cmp =
        maxv.blockPosition - lowestBlock || maxv.dataPosition - lowestData
      if (cmp > 0) {
        filtered.push(chunk)
      }
    }
    if (filtered.length === 0) {
      return filtered
    }
  } else {
    filtered = chunks
  }

  filtered.sort((c0, c1) => {
    const dif = c0.minv.blockPosition - c1.minv.blockPosition
    return dif !== 0 ? dif : c0.minv.dataPosition - c1.minv.dataPosition
  })

  // Source chunks are shared with the index's per-refId cache, so we never
  // mutate them — extending a merged span produces a new Chunk instance.
  const mergedChunks: Chunk[] = [filtered[0]!]
  let lastMinBlock = filtered[0]!.minv.blockPosition
  let lastMaxBlock = filtered[0]!.maxv.blockPosition

  for (let i = 1; i < filtered.length; i++) {
    const chunk = filtered[i]!
    const chunkMinBlock = chunk.minv.blockPosition
    const chunkMaxBlock = chunk.maxv.blockPosition
    // Merge if chunks are close enough: small gap between them, and the
    // combined span is bounded so we don't grow a single chunk indefinitely.
    //
    // Both constants were swept before being left alone — see ADR 0011.
    // Dropping merging entirely, on the theory that a caller with a coalescing
    // range cache makes it redundant, is much worse: a bare consumer goes from
    // 6 reads to 95-378 on the same queries AND downloads MORE, because every
    // small chunk pays its own tail padding where a merged one amortizes it.
    // Raising the gap is worse too, partly because it blunts the early stop in
    // _fetchChunkFeatures. Records are identical either way; only the I/O moves.
    if (
      chunkMinBlock - lastMaxBlock < 65000 &&
      chunkMaxBlock - lastMinBlock < 5000000
    ) {
      const lastChunk = mergedChunks[mergedChunks.length - 1]!
      const cmp =
        chunkMaxBlock - lastMaxBlock ||
        chunk.maxv.dataPosition - lastChunk.maxv.dataPosition
      if (cmp > 0) {
        mergedChunks[mergedChunks.length - 1] = new Chunk(
          lastChunk.minv,
          chunk.maxv,
          lastChunk.bin,
          chunk.endPosition,
        )
        lastMaxBlock = chunkMaxBlock
      }
    } else {
      mergedChunks.push(chunk)
      lastMinBlock = chunkMinBlock
      lastMaxBlock = chunkMaxBlock
    }
  }

  return makeDisjoint(mergedChunks)
}

/**
 * Trim any chunk that starts before its predecessor ends, so the spans a query
 * reads never overlap.
 *
 * Merging alone does not guarantee this. Two chunks from different bins can
 * overlap inside a single BGZF block while the merge above still declines to
 * join them, because the combined span would exceed its 5MB cap — on
 * test/data/out.bam that leaves `3804:0-4977599:16404` next to
 * `4977599:5843-9719917:27612`, whose 10561 shared bytes of block 4977599 get
 * fetched, decompressed and decoded by both. Every record in the overlap is
 * then returned TWICE from getRecordsForRange (5 of out.bam's 6551), which a
 * consumer sees as a duplicated read: rendered twice, counted twice in
 * coverage, and colliding on any id derived from fileOffset.
 *
 * Safe because a BAI chunk's `maxv` is the virtual offset just past its last
 * record — a record boundary — so no record begins inside the trimmed span and
 * the union of the chunks is unchanged. Verified by record counts: the
 * duplicates disappear and the number of DISTINCT records is identical.
 */
function makeDisjoint(chunks: Chunk[]) {
  const out: Chunk[] = [chunks[0]!]
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const prevMax = out[out.length - 1]!.maxv
    const cmp =
      chunk.minv.blockPosition - prevMax.blockPosition ||
      chunk.minv.dataPosition - prevMax.dataPosition
    if (cmp >= 0) {
      out.push(chunk)
      continue
    }
    // starts inside the previous chunk: begin where that one ended, and drop it
    // entirely if that leaves nothing
    const stillHasData =
      chunk.maxv.blockPosition - prevMax.blockPosition ||
      chunk.maxv.dataPosition - prevMax.dataPosition
    if (stillHasData > 0) {
      out.push(new Chunk(prevMax, chunk.maxv, chunk.bin, chunk.endPosition))
    }
  }
  return out
}

// The pseudo-bin's mapped-record count, a little-endian uint64. Read as two
// 32-bit halves rather than via BigInt: exact up to Number.MAX_SAFE_INTEGER,
// which is far past any real record count, and allocates nothing.
export function parsePseudoBin(bytes: Uint8Array, offset: number) {
  const low =
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  const high =
    bytes[offset + 4]! |
    (bytes[offset + 5]! << 8) |
    (bytes[offset + 6]! << 16) |
    (bytes[offset + 7]! << 24)
  return {
    lineCount: (high >>> 0) * 2 ** 32 + (low >>> 0),
  }
}

// Tighten each chunk's endPosition (default: a full max-size BGZF block past
// maxv) down to the next known block boundary. Every chunk min/maxv blockPosition
// and every extraBoundary (e.g. linear-index entries) is a real BGZF block start;
// since blocks don't overlap, the first boundary strictly greater than a chunk's
// maxv.blockPosition is an upper bound on where that final block ends — always at
// least the true block end, so the clamped fetch still contains the whole block.
// Shrinks both the byte estimate and the actual fetch with no extra I/O.
export function clampChunkEnds(
  chunks: Chunk[],
  extraBoundaries: ArrayLike<number> = [],
) {
  if (chunks.length === 0) {
    return
  }
  // A plain array, pre-sized and filled by index. Measured against both
  // alternatives on five real .bai shapes (min of 21, interleaved, sign-stable
  // over 3 runs): building with push instead is 5-8% slower, and a
  // Float64Array is faster to sort but allocates per reference, which costs
  // 1.7x on an assembly with tens of thousands of unplaced scaffolds
  // (cho.bam.bai has 28751 references, each with a handful of boundaries).
  // Filling by index also avoids the intermediate array that mapping the
  // linear index to block positions used to build.
  const boundaries = new Array<number>(
    extraBoundaries.length + chunks.length * 2,
  )
  let n = 0
  for (let i = 0, l = extraBoundaries.length; i < l; i++) {
    boundaries[n++] = extraBoundaries[i]!
  }
  for (const c of chunks) {
    boundaries[n++] = c.minv.blockPosition
    boundaries[n++] = c.maxv.blockPosition
  }
  boundaries.sort((a, b) => a - b)

  for (const c of chunks) {
    const max = c.maxv.blockPosition
    // first boundary strictly greater than max
    let lo = 0
    let hi = boundaries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (boundaries[mid]! > max) {
        hi = mid
      } else {
        lo = mid + 1
      }
    }
    if (lo < boundaries.length) {
      c.endPosition = Math.min(c.endPosition, boundaries[lo]!)
    }
  }
}

// Parse the BAM reference-sequence table (SAMv1.pdf §4.2). Returns undefined
// if `uncba` doesn't yet contain the full table — caller fetches more bytes
// and retries.
export function parseRefSeqs(
  uncba: Uint8Array,
  start: number,
  renameRefSeq: (s: string) => string,
) {
  if (start + 4 > uncba.length) {
    return undefined
  }
  const dataView = new DataView(
    uncba.buffer,
    uncba.byteOffset,
    uncba.byteLength,
  )
  const nRef = dataView.getInt32(start, true)
  // null prototype: ref names come from the file, so a contig named
  // "constructor" must not resolve to Object.prototype's
  const chrToIndex: Record<string, number> = Object.create(null)
  const indexToChr: { refName: string; length: number }[] = []
  const decoder = new TextDecoder('utf8')

  let p = start + 4
  for (let i = 0; i < nRef; i++) {
    if (p + 8 > uncba.length) {
      return undefined
    }
    const lName = dataView.getInt32(p, true)
    if (p + 8 + lName > uncba.length) {
      return undefined
    }
    const refName = renameRefSeq(
      decoder.decode(uncba.subarray(p + 4, p + 4 + lName - 1)),
    )
    const lRef = dataView.getInt32(p + lName + 4, true)
    chrToIndex[refName] = i
    indexToChr.push({ refName, length: lRef })
    p += 8 + lName
  }
  // end is the offset just past the header, i.e. where alignment records start
  return { chrToIndex, indexToChr, end: p }
}

// SYNC: ~/src/gmod/tabix-js/src/util.ts minVirtualOffset — but NOT the 0:0
// skip below, which is only sound for BAM. A tabix'd file with no header lines
// really does have its first record at 0:0.
/**
 * The smallest of `current` and the `count` packed virtual offsets starting at
 * `offset`, allocating at most one VirtualOffset rather than one per entry.
 *
 * 0:0 is skipped rather than treated as the minimum. No BAM record can live
 * there — the magic and header occupy the start of the file — so it is the
 * "unset" placeholder htslib leaves in linear-index windows ahead of a
 * reference's first read (see test/data/HG00096_illumina_lowcov.bam.bai, whose
 * first three windows are 0). Counting it collapses firstDataLine to 0:0 and
 * makes callers size a header read from nothing.
 *
 * The index first pass exists only to find this minimum, and it visits every
 * linear-index entry in the file to do it. Building a VirtualOffset per entry
 * to compare and discard it is the bulk of that pass.
 */
export function minVirtualOffset(
  bytes: Uint8Array,
  offset: number,
  count: number,
  current: VirtualOffset | undefined,
) {
  let minBlock = current ? current.blockPosition : Infinity
  let minData = current ? current.dataPosition : 0
  let found = false
  for (let i = 0; i < count; i++) {
    const p = offset + i * 8
    const block =
      bytes[p + 7]! * 0x10000000000 +
      bytes[p + 6]! * 0x100000000 +
      bytes[p + 5]! * 0x1000000 +
      bytes[p + 4]! * 0x10000 +
      bytes[p + 3]! * 0x100 +
      bytes[p + 2]!
    const data = (bytes[p + 1]! << 8) | bytes[p]!
    if (
      (block !== 0 || data !== 0) &&
      (block < minBlock || (block === minBlock && data < minData))
    ) {
      minBlock = block
      minData = data
      found = true
    }
  }
  return found ? new VirtualOffset(minBlock, minData) : current
}

// SYNC: ~/src/gmod/tabix-js/src/util.ts parseNameBytes uses indexOf(0) instead of byte scan
export function parseNameBytes(
  namesBytes: Uint8Array,
  renameRefSeq: (arg: string) => string = s => s,
) {
  const decoder = new TextDecoder()
  let currRefId = 0
  let currNameStart = 0
  const refIdToName: string[] = []
  const refNameToId: Record<string, number> = Object.create(null)
  for (let i = 0; i < namesBytes.length; i++) {
    if (!namesBytes[i]) {
      if (currNameStart < i) {
        const refName = renameRefSeq(
          decoder.decode(namesBytes.subarray(currNameStart, i)),
        )
        refIdToName[currRefId] = refName
        refNameToId[refName] = currRefId
      }
      currNameStart = i + 1
      currRefId++
    }
  }
  return { refNameToId, refIdToName }
}

export function concatUint8Array(args: Uint8Array[]) {
  let totalLength = 0
  for (const entry of args) {
    totalLength += entry.length
  }
  const mergedArray = new Uint8Array(totalLength)
  let offset = 0
  for (const entry of args) {
    mergedArray.set(entry, offset)
    offset += entry.length
  }
  return mergedArray
}

interface Positioned {
  ref_id: number
  start: number
  end: number
}

// The end htslib's bam_endpos() reports: a record consuming no reference —
// an unmapped mate placed at its mate's coordinate, or an empty CIGAR — still
// covers one base rather than none, so it can be found by a query on the base
// it sits at.
function endpos(r: Positioned) {
  return r.end > r.start ? r.end : r.start + 1
}

// Append records overlapping [min, max) on `chrId` into `out` (or a fresh
// array if omitted). Records are assumed coordinate-sorted (by ref_id, then
// start), so we stop scanning once we pass `max` within `chrId` or move past
// `chrId` entirely. Returns the populated array.
//
// `end` is exclusive, so overlap is `end > min`, not `end >= min`: a read
// finishing exactly where the query begins shares no base with it. samtools
// agrees — `samtools view f.bam chr:124001-124300` omits a 150M read at
// 1-based POS 123851, which ends at 124000.
export function appendInRange<T extends Positioned>(
  records: T[],
  chrId: number,
  min: number,
  max: number,
  out: T[] = [],
): T[] {
  for (let i = 0, l = records.length; i < l; i++) {
    const r = records[i]!
    if (r.ref_id === chrId) {
      if (r.start >= max) {
        break
      } else if (endpos(r) > min) {
        out.push(r)
      }
    } else if (r.ref_id > chrId) {
      break
    }
  }
  return out
}
