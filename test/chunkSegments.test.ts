// readBamFeatures over segments has to give the records a single buffer gives,
// wherever the seams fall: on a record boundary, inside a record, inside its
// 4-byte size field, and with one record spanning several segments.
import { readFileSync } from 'node:fs'

import { scanBgzfBlocks, unzip, unzipChunkSlice } from '@gmod/bgzf-filehandle'
import { expect, test } from 'vitest'

import Chunk from '../src/chunk.ts'
import { BamFile } from '../src/index.ts'
import { VirtualOffset } from '../src/virtualOffset.ts'

import type BAMFeature from '../src/record.ts'
import type { BgzfBlockInfo, BgzfWorkerPool } from '@gmod/bgzf-filehandle'

const FIXTURES = [
  'test/data/volvox-sorted.bam',
  'test/data/shortreads_300x.bam',
  'test/data/ultra-long-ont_hs37d5_phased.subsel.bam',
]

/** every record in the file, as one chunk starting after the header */
async function wholeFileChunk(file: string) {
  const input = new Uint8Array(readFileSync(file))
  const bytes = await unzip(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let headerEnd = 8 + view.getInt32(4, true)
  const nRef = view.getInt32(headerEnd, true)
  headerEnd += 4
  for (let i = 0; i < nRef; i++) {
    headerEnd += 8 + view.getInt32(headerEnd, true)
  }
  const blocks = scanBgzfBlocks(input, 0, input.length)
  let first = 0
  let offset = 0
  while (offset + blocks[first]!.decompressedSize <= headerEnd) {
    offset += blocks[first]!.decompressedSize
    first++
  }
  const last = blocks.at(-1)!
  const chunk = new Chunk(
    new VirtualOffset(blocks[first]!.filePosition, headerEnd - offset),
    new VirtualOffset(last.filePosition, last.decompressedSize),
    0,
  )
  const slice = await unzipChunkSlice(
    input.subarray(chunk.minv.blockPosition),
    chunk,
  )
  return { input, chunk, slice }
}

function split(buffer: Uint8Array, cuts: number[]) {
  const sorted = [...new Set(cuts)]
    .filter(c => c > 0 && c < buffer.length)
    .sort((a, b) => a - b)
  const segments: Uint8Array[] = []
  let at = 0
  for (const cut of [...sorted, buffer.length]) {
    // a copy, as each worker's range is its own buffer
    segments.push(buffer.slice(at, cut))
    at = cut
  }
  return segments
}

function identity(r: BAMFeature) {
  return `${r.fileOffset}|${r.name}|${r.start}`
}

function recordStarts(buffer: Uint8Array) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const starts: number[] = []
  for (let at = 0; at + 4 < buffer.length; at += 4 + view.getInt32(at, true)) {
    starts.push(at)
  }
  return starts
}

test.each(FIXTURES)(
  'segments give the same records as one buffer: %s',
  async file => {
    const bam = new BamFile({ bamPath: file })
    await bam.getHeader()
    const { chunk, slice } = await wholeFileChunk(file)
    const { buffer, cpositions, dpositions } = slice
    const joined = bam.readBamFeatures(buffer, cpositions, dpositions, chunk)
    expect(joined.length).toBeGreaterThan(10)
    const expected = joined.map(identity)
    const starts = recordStarts(buffer)

    const cutsBy: Record<string, number[]> = {
      'record boundaries': starts.filter((_, i) => i % 3 === 0),
      'inside a record': starts.map(s => s + 37),
      'inside the size field': starts.flatMap((s, i) => [s + 1 + (i % 3)]),
      'every 1000 bytes': Array.from(
        { length: Math.floor(buffer.length / 1000) },
        (_, i) => (i + 1) * 1000,
      ),
    }
    for (const [label, cuts] of Object.entries(cutsBy)) {
      const segments = split(buffer, cuts)
      const records = bam.readBamFeatures(
        segments,
        cpositions,
        dpositions,
        chunk,
      )
      expect(records.map(identity), label).toStrictEqual(expected)
      // every decoded field, so a record cut short or misaligned shows
      expect(
        records.map(r => JSON.stringify(r.toJSON())),
        label,
      ).toStrictEqual(joined.map(r => JSON.stringify(r.toJSON())))
    }
  },
)

test('a query through a pool that returns many segments matches one without', async () => {
  // every block in a buffer of its own, so unzipChunkSegments hands back a
  // segment per block and nearly every record boundary is near a seam
  let pooledCalls = 0
  const pool: BgzfWorkerPool = {
    async decompressBlocks(input: Uint8Array, blocks: BgzfBlockInfo[]) {
      pooledCalls++
      return {
        blocks: await Promise.all(
          blocks.map(b =>
            unzip(
              input.subarray(b.inputOffset, b.inputOffset + b.compressedSize),
            ),
          ),
        ),
      }
    },
    destroy: () => undefined,
  }
  const file = 'test/data/shortreads_300x.bam'
  const plain = new BamFile({ bamPath: file })
  const pooled = new BamFile({ bamPath: file, bgzfWorkerPool: pool })
  const [a, b] = await Promise.all([
    plain.getRecordsForRange('1', 197_700_000, 197_800_000),
    pooled.getRecordsForRange('1', 197_700_000, 197_800_000),
  ])
  expect(a.length).toBe(53_596)
  expect(pooledCalls).toBeGreaterThan(0)
  expect(b.map(identity)).toStrictEqual(a.map(identity))
})
