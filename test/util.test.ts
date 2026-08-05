import { expect, test } from 'vitest'

import Chunk from '../src/chunk.ts'
import {
  appendInRange,
  clampChunkEnds,
  minVirtualOffset,
  optimizeChunks,
  parseRefSeqs,
} from '../src/util.ts'
import { VirtualOffset } from '../src/virtualOffset.ts'

function chunk(min: number, max: number, bin = 0) {
  return new Chunk(new VirtualOffset(min, 0), new VirtualOffset(max, 0), bin)
}

test('clampChunkEnds tightens tail to next known block boundary', () => {
  const block = 1 << 16
  const c1 = chunk(0, 1000)
  const c2 = chunk(2000, 5000)
  expect(c1.fetchedSize()).toEqual(1000 + block)

  clampChunkEnds([c1, c2])

  // c1.maxv=1000, next boundary > 1000 is c2.minv=2000 → end clamped to 2000
  expect(c1.endPosition).toEqual(2000)
  expect(c1.fetchedSize()).toEqual(2000)
  // c2 has no boundary beyond its maxv → keeps full-block padding
  expect(c2.endPosition).toEqual(5000 + block)
})

test('clampChunkEnds keeps padding when no nearby boundary', () => {
  const block = 1 << 16
  const c1 = chunk(0, 0)
  const c2 = chunk(block * 5, block * 5)
  clampChunkEnds([c1, c2])
  expect(c1.endPosition).toEqual(block)
})

test('clampChunkEnds uses extra (linear-index) boundaries', () => {
  const c = chunk(0, 100)
  clampChunkEnds([c], [500, 300, 50])
  expect(c.endPosition).toEqual(300)
})

// BAI hands its linear index over as a Float64Array rather than materializing a
// VirtualOffset per 16kb window, so that is the shape this actually sees.
test('clampChunkEnds accepts a Float64Array of boundaries', () => {
  const c = chunk(0, 100)
  clampChunkEnds([c], Float64Array.of(500, 300, 50))
  expect(c.endPosition).toEqual(300)
})

// Two chunks from different bins can overlap inside one BGZF block while the
// merge still declines to join them, because the combined span would exceed its
// 5MB cap. The overlapping bytes were then fetched, decompressed and decoded
// twice, and every record in them came back twice from getRecordsForRange.
test('optimizeChunks leaves no overlapping spans', () => {
  const a = new Chunk(
    new VirtualOffset(3804, 0),
    new VirtualOffset(4977599, 16404),
    1,
  )
  // starts inside `a`, and too far away to merge (span > 5MB)
  const b = new Chunk(
    new VirtualOffset(4977599, 5843),
    new VirtualOffset(9719917, 27612),
    2,
  )
  const out = optimizeChunks([a, b])

  expect(out.length).toBe(2)
  // b now begins exactly where a ended
  expect(out[1]!.minv.blockPosition).toBe(4977599)
  expect(out[1]!.minv.dataPosition).toBe(16404)
  // the union is unchanged at both ends
  expect(out[0]!.minv.blockPosition).toBe(3804)
  expect(out[1]!.maxv.blockPosition).toBe(9719917)
  expect(out[1]!.maxv.dataPosition).toBe(27612)
})

// a chunk swallowed entirely by its predecessor contributes nothing
test('optimizeChunks drops a chunk contained in its predecessor', () => {
  const a = new Chunk(
    new VirtualOffset(0, 0),
    new VirtualOffset(6_000_000, 500),
    1,
  )
  const b = new Chunk(
    new VirtualOffset(10, 0),
    new VirtualOffset(6_000_000, 100),
    2,
  )
  const out = optimizeChunks([a, b])
  expect(out.length).toBe(1)
  expect(out[0]!.maxv.dataPosition).toBe(500)
})

test('optimizeChunks merges close chunks without mutating inputs', () => {
  const a = chunk(0, 100)
  const b = chunk(200, 300)
  const aMaxBefore = a.maxv
  const merged = optimizeChunks([a, b])
  expect(merged).toHaveLength(1)
  expect(merged[0]!.minv.blockPosition).toEqual(0)
  expect(merged[0]!.maxv.blockPosition).toEqual(300)
  // input chunks must not be mutated — they are shared with the index cache
  expect(a.maxv).toBe(aMaxBefore)
  expect(a.maxv.blockPosition).toEqual(100)
})

test('optimizeChunks does not merge chunks far apart', () => {
  const merged = optimizeChunks([chunk(0, 100), chunk(1_000_000, 1_000_100)])
  expect(merged).toHaveLength(2)
})

test('optimizeChunks bounded by 5MB combined span', () => {
  // chunks adjacent enough to merge by gap, but combined span > 5MB blocks
  const merged = optimizeChunks([chunk(0, 100), chunk(64_000, 6_000_000)])
  expect(merged).toHaveLength(2)
})

test('optimizeChunks filters chunks below lowest', () => {
  const merged = optimizeChunks(
    [chunk(0, 50), chunk(100, 200)],
    new VirtualOffset(75, 0),
  )
  expect(merged).toHaveLength(1)
  expect(merged[0]!.minv.blockPosition).toEqual(100)
})

test('optimizeChunks returns empty when all chunks filtered out', () => {
  const merged = optimizeChunks([chunk(0, 50)], new VirtualOffset(100, 0))
  expect(merged).toEqual([])
})

test('optimizeChunks repeated runs are stable', () => {
  const input = [chunk(0, 100), chunk(200, 300)]
  const first = optimizeChunks(input)
  const second = optimizeChunks(input)
  expect(first[0]!.maxv.blockPosition).toEqual(300)
  expect(second[0]!.maxv.blockPosition).toEqual(300)
})

test('appendInRange stops scanning past max', () => {
  const records = [
    { ref_id: 0, start: 0, end: 5 },
    { ref_id: 0, start: 10, end: 20 },
    { ref_id: 0, start: 100, end: 110 },
  ]
  const out = appendInRange(records, 0, 0, 30)
  expect(out).toHaveLength(2)
})

test('appendInRange filters by chrId', () => {
  const out = appendInRange(
    [
      { ref_id: 0, start: 10, end: 20 },
      { ref_id: 1, start: 10, end: 20 },
    ],
    1,
    0,
    100,
  )
  expect(out).toHaveLength(1)
  expect(out[0]!.ref_id).toEqual(1)
})

test('appendInRange stops scanning once past chrId', () => {
  const records = [
    { ref_id: 0, start: 10, end: 20 },
    { ref_id: 1, start: 10, end: 20 },
    { ref_id: 2, start: 10, end: 20 },
  ]
  const out = appendInRange(records, 0, 0, 100)
  expect(out).toHaveLength(1)
  expect(out[0]!.ref_id).toEqual(0)
})

test('appendInRange drops records ending before min', () => {
  const out = appendInRange(
    [
      { ref_id: 0, start: 0, end: 5 },
      { ref_id: 0, start: 10, end: 20 },
    ],
    0,
    10,
    100,
  )
  expect(out).toHaveLength(1)
})

test('parseRefSeqs returns undefined when buffer is truncated', () => {
  const buf = new Uint8Array(2)
  expect(parseRefSeqs(buf, 0, s => s)).toBeUndefined()
})

test('parseRefSeqs decodes refs and honors renameRefSeq', () => {
  // nRef=2, ref0 name "ctgA" lRef=100, ref1 name "ctgB" lRef=200
  const buf = new Uint8Array(4 + 4 + 5 + 4 + 4 + 5 + 4)
  const dv = new DataView(buf.buffer)
  dv.setInt32(0, 2, true) // nRef
  let p = 4
  dv.setInt32(p, 5, true) // lName for "ctgA\0"
  p += 4
  buf.set([99, 116, 103, 65, 0], p)
  p += 5
  dv.setInt32(p, 100, true)
  p += 4
  dv.setInt32(p, 5, true)
  p += 4
  buf.set([99, 116, 103, 66, 0], p)
  p += 5
  dv.setInt32(p, 200, true)

  const out = parseRefSeqs(buf, 0, name => name.toUpperCase())
  expect(out).toEqual({
    chrToIndex: { CTGA: 0, CTGB: 1 },
    indexToChr: [
      { refName: 'CTGA', length: 100 },
      { refName: 'CTGB', length: 200 },
    ],
    // records start after the ref-seq table, i.e. at the end of this buffer
    end: buf.length,
  })
})

function packOffsets(offsets: [number, number][]) {
  const buf = new Uint8Array(8 * offsets.length)
  const dv = new DataView(buf.buffer)
  offsets.forEach(([block, data], i) => {
    dv.setBigUint64(8 * i, (BigInt(block) << 16n) | BigInt(data), true)
  })
  return buf
}

test('minVirtualOffset skips unset 0:0 entries', () => {
  // htslib leaves linear-index windows ahead of a reference's first read at 0,
  // and no BAM record can be at 0:0 since the header occupies the file start
  const buf = packOffsets([
    [0, 0],
    [0, 0],
    [69596, 0],
    [70000, 12],
  ])
  expect(String(minVirtualOffset(buf, 0, 4, undefined))).toEqual('69596:0')
  expect(
    String(minVirtualOffset(buf, 0, 4, new VirtualOffset(80000, 0))),
  ).toEqual('69596:0')
  // a nonzero data position at block 0 is a real offset, not a placeholder
  expect(
    String(minVirtualOffset(packOffsets([[0, 179]]), 0, 1, undefined)),
  ).toEqual('0:179')
})

test('minVirtualOffset returns current when every entry is unset', () => {
  const buf = packOffsets([
    [0, 0],
    [0, 0],
  ])
  expect(minVirtualOffset(buf, 0, 2, undefined)).toBeUndefined()
})
