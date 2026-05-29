import Chunk from './chunk.ts'
import { longFromBytesToUnsigned } from './long.ts'

import type { Offset, VirtualOffset } from './virtualOffset.ts'

export interface TagFilter {
  tag: string
  value?: string
}

export interface FilterBy {
  flagInclude?: number
  flagExclude?: number
  tagFilter?: TagFilter
}

export interface BamOpts {
  viewAsPairs?: boolean
  pairAcrossChr?: boolean
  maxInsertSize?: number
  signal?: AbortSignal
  filterBy?: FilterBy
}

export interface BaseOpts {
  signal?: AbortSignal
}

export function optimizeChunks(chunks: Chunk[], lowest?: Offset) {
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
        )
        lastMaxBlock = chunkMaxBlock
      }
    } else {
      mergedChunks.push(chunk)
      lastMinBlock = chunkMinBlock
      lastMaxBlock = chunkMaxBlock
    }
  }

  return mergedChunks
}

export function parsePseudoBin(bytes: Uint8Array, offset: number) {
  return {
    lineCount: longFromBytesToUnsigned(bytes, offset),
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
  const dataView = new DataView(uncba.buffer)
  const nRef = dataView.getInt32(start, true)
  const chrToIndex: Record<string, number> = {}
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
  return { chrToIndex, indexToChr }
}

export function findFirstData(
  firstDataLine: VirtualOffset | undefined,
  virtualOffset: VirtualOffset,
) {
  return firstDataLine
    ? firstDataLine.compareTo(virtualOffset) > 0
      ? virtualOffset
      : firstDataLine
    : virtualOffset
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
  const refNameToId: Record<string, number> = {}
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

export function filterReadFlag(
  flags: number,
  flagInclude: number,
  flagExclude: number,
) {
  return (flags & flagInclude) !== flagInclude || (flags & flagExclude) !== 0
}

export function filterTagValue(readVal: unknown, filterVal?: string) {
  return filterVal === '*'
    ? readVal === undefined
    : `${readVal}` !== `${filterVal}`
}

export function filterCacheKey(filterBy?: FilterBy) {
  if (!filterBy) {
    return ''
  }
  const { flagInclude = 0, flagExclude = 0, tagFilter } = filterBy
  const tagPart = tagFilter ? `:${tagFilter.tag}=${tagFilter.value ?? '*'}` : ''
  return `:f${flagInclude}x${flagExclude}${tagPart}`
}

interface Filterable {
  flags: number
  tags: Record<string, unknown>
}

// Apply flagInclude/flagExclude/tagFilter to a list of records.
export function applyFilters<T extends Filterable>(
  records: T[],
  filterBy: FilterBy,
): T[] {
  const { flagInclude = 0, flagExclude = 0, tagFilter } = filterBy
  const out: T[] = []
  for (let i = 0, l = records.length; i < l; i++) {
    const r = records[i]!
    if (
      !filterReadFlag(r.flags, flagInclude, flagExclude) &&
      !(tagFilter && filterTagValue(r.tags[tagFilter.tag], tagFilter.value))
    ) {
      out.push(r)
    }
  }
  return out
}

interface Positioned {
  ref_id: number
  start: number
  end: number
}

// Append records overlapping [min, max) on `chrId` into `out` (or a fresh
// array if omitted). Records are assumed coordinate-sorted (by ref_id, then
// start), so we stop scanning once we pass `max` within `chrId` or move past
// `chrId` entirely. Returns the populated array.
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
      } else if (r.end >= min) {
        out.push(r)
      }
    } else if (r.ref_id > chrId) {
      break
    }
  }
  return out
}
