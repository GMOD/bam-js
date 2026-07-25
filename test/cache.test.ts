import { expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'

// Parsed records are views into their chunk's decompressed buffer, so a cached
// entry pins that whole buffer. The cache therefore budgets decompressed bytes
// rather than counting entries, which would leave memory unbounded.
test('chunk cache stays within its byte budget', async () => {
  const maxCacheBytes = 4 * 1024 * 1024
  const bam = new BamFile({ bamPath: 'test/data/out.bam', maxCacheBytes })
  await bam.getHeader()

  for (let i = 0; i < 12; i++) {
    const start = i * 2_000_000 + 1
    await bam.getRecordsForRange('1', start, start + 400_000)
  }

  const cache = bam.chunkFeatureCache
  expect(cache.maxBytes).toBe(maxCacheBytes)
  expect(cache.size).toBeGreaterThan(0)
  expect(cache.byteSize).toBeLessThanOrEqual(maxCacheBytes)

  bam.clearFeatureCache()
  expect(cache.size).toBe(0)
  expect(cache.byteSize).toBe(0)
})

// A chunk bigger than the whole budget is still cached: the caller needs it for
// the query in flight, so evicting it would only force a re-decompress.
test('a single over-budget chunk is still cached', async () => {
  const bam = new BamFile({ bamPath: 'test/data/out.bam', maxCacheBytes: 1 })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('1', 1, 1_000_000)

  expect(records.length).toBeGreaterThan(0)
  expect(bam.chunkFeatureCache.size).toBe(1)
  expect(bam.chunkFeatureCache.byteSize).toBeGreaterThan(1)
})

test('repeated queries over the same region hit the cache', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()

  const first = await bam.getRecordsForRange('ctgA', 1, 5000)
  const bytesAfterFirst = bam.chunkFeatureCache.byteSize
  const second = await bam.getRecordsForRange('ctgA', 1, 5000)

  expect(second.length).toBe(first.length)
  // same records, not re-parsed copies
  expect(second[0]).toBe(first[0])
  expect(bam.chunkFeatureCache.byteSize).toBe(bytesAfterFirst)
})

test('ref names do not resolve to Object.prototype members', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()

  expect(bam.chrToIndex?.constructor).toBeUndefined()
  expect(await bam.getRecordsForRange('constructor', 1, 100)).toEqual([])
  expect(await bam.hasRefSeq('constructor')).toBe(false)
})
