import { vi } from 'vitest'

import Chunk from '../../src/chunk.ts'

import type { BamFile } from '../../src/index.ts'

export const QUERY_END = 1000

/**
 * Stub `bam`'s index and chunk reads so a query over `ctgA:0-QUERY_END` sees
 * `head` chunks of records inside it followed by `tail` chunks past it, three
 * records apiece, with only `_fetchChunkFeatures` left real.
 *
 * The early stop needs chunks past the query that the index cannot rule out,
 * and since `max_off` (ADR 0023) no fixture here has any: it drops them from
 * the index alone. Real files still do — jb2bench's 1000x.longread hands back
 * 13 chunks for a 1kb window and the stop reads 6 — but building one is a
 * ~100MB fixture, so the chunk list and records are supplied directly.
 */
export async function syntheticQuery(bam: BamFile, head: number, tail: number) {
  await bam.getHeader()
  const chrId = bam.chrToIndex!.ctgA!
  const chunks: Chunk[] = []
  for (let i = 0, pos = 0; i < head + tail; i++, pos += 1000) {
    chunks.push(
      new Chunk(
        { blockPosition: pos, dataPosition: 0 },
        { blockPosition: pos + 1000, dataPosition: 0 },
        i,
        pos + 1000,
      ),
    )
  }
  vi.spyOn(bam.index!, 'blocksForRange').mockResolvedValue(chunks)
  return vi
    .spyOn(
      bam as unknown as {
        _readChunkFeatures: (chunk: Chunk) => Promise<unknown>
      },
      '_readChunkFeatures',
    )
    .mockImplementation(async (chunk: Chunk) => {
      const i = chunk.bin
      const base = i < head ? i * 100 : QUERY_END + (i - head + 1) * 100
      await Promise.resolve()
      return {
        features: Array.from({ length: 3 }, (_, k) => ({
          ref_id: chrId,
          start: base + k,
          end: base + k + 1,
        })),
        bytes: 100,
      }
    })
}
