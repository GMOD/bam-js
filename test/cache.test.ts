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

// A query spanning several chunks used to evict cached entries whose *block*
// range overlapped the incoming one. Adjacent chunks share the BGZF block at
// their boundary (chunk A's maxv and chunk B's minv are the same virtual
// offset), so every multi-chunk query threw away the chunks it had just parsed
// and the next query re-decompressed all of them.
test('a multi-chunk query keeps every chunk it parsed', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()

  const chunks = await bam.blocksForRange('22', 16_449_999, 16_490_000)
  expect(chunks.length).toBeGreaterThan(1)

  await bam.getRecordsForRange('22', 16_450_000, 16_490_000)
  expect(bam.chunkFeatureCache.size).toBe(chunks.length)
})

// Panning is the dominant access pattern in a genome browser, and consecutive
// windows resolve to the same chunks until the bin set changes.
test('panning within the same chunks re-uses parsed records', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()

  await bam.getRecordsForRange('22', 16_450_000, 16_490_000)
  const bytesAfterFirst = bam.chunkFeatureCache.byteSize
  const panned = await bam.getRecordsForRange('22', 16_460_000, 16_500_000)

  expect(panned.length).toBeGreaterThan(0)
  expect(bam.chunkFeatureCache.byteSize).toBe(bytesAfterFirst)
})

// Counts how many times a chunk is actually read+decompressed, by wrapping the
// one method every cache miss goes through.
function countChunkReads(bam: BamFile) {
  const stats = { reads: 0 }
  const inner = bam._readChunkFeatures.bind(bam)
  bam._readChunkFeatures = async (chunk, opts) => {
    stats.reads++
    return inner(chunk, opts)
  }
  return stats
}

// A genome browser renders a row of adjacent blocks concurrently, and those
// queries collapse onto very few chunk keys. Without in-flight de-duplication
// every one of them missed the cache (nothing is published until a read
// finishes) and re-decompressed the same chunk — the most expensive part of a
// cold query.
test('concurrent queries over the same chunk decompress it once', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()
  const stats = countChunkReads(bam)

  const width = 5000
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      bam.getRecordsForRange(
        '22',
        16_450_000 + i * width,
        16_450_000 + (i + 1) * width,
      ),
    ),
  )

  expect(results.some(r => r.length > 0)).toBe(true)
  // one read per distinct chunk, not one per query
  expect(stats.reads).toBe(bam.chunkFeatureCache.size)
})

// The same chunk requested concurrently must hand back the identical parsed
// records, not two independently-decoded copies (ADR 0006).
test('concurrent queries share one set of record objects', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const stats = countChunkReads(bam)

  const [a, b] = await Promise.all([
    bam.getRecordsForRange('ctgA', 1, 5000),
    bam.getRecordsForRange('ctgA', 1, 5000),
  ])

  expect(stats.reads).toBe(bam.chunkFeatureCache.size)
  expect(a.length).toBeGreaterThan(0)
  expect(b[0]).toBe(a[0])
})

// Chunks are read concurrently, so they finish in whatever order the transport
// hands them back. The records must still be assembled in chunk order — the
// order a sequential walk produced — so the output never depends on timing.
// (Chunk order is not the same as coordinate order: bins at different levels
// cover overlapping spans, so the concatenation was never globally sorted.)
test('record order does not depend on which chunk finishes first', async () => {
  async function fetchWith(delay: (callIndex: number) => number) {
    const bam = new BamFile({ bamPath: 'test/data/out.bam' })
    await bam.getHeader()
    const chunks = await bam.blocksForRange('1', 0, 1_000_000_000)
    expect(chunks.length).toBeGreaterThan(1)

    let call = 0
    const inner = bam._readChunkFeatures.bind(bam)
    bam._readChunkFeatures = async (chunk, opts) => {
      const ms = delay(call++)
      const result = await inner(chunk, opts)
      await new Promise(resolve => {
        setTimeout(resolve, ms)
      })
      return result
    }
    const records = await bam.getRecordsForRange('1', 0, 1_000_000_000)
    return records.map(r => `${r.fileOffset}:${r.start}`)
  }

  // later chunks finish first, exactly inverting the natural completion order
  const inOrder = await fetchWith(() => 0)
  const reversed = await fetchWith(i => (16 - i) * 2)

  expect(inOrder.length).toBeGreaterThan(0)
  expect(reversed).toEqual(inOrder)
})

test('ref names do not resolve to Object.prototype members', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()

  expect(bam.chrToIndex?.constructor).toBeUndefined()
  expect(await bam.getRecordsForRange('constructor', 1, 100)).toEqual([])
  expect(await bam.hasRefSeq('constructor')).toBe(false)
})

// Only the caller that *starts* a chunk read passes its signal down to
// bam.read, so if that caller aborts, the shared promise rejects for everyone —
// including queries that are still perfectly alive. Sharing the read must not
// mean sharing the owner's cancellation (ADR 0007).
//
// Hangs the first read until it is aborted, so the second query is guaranteed
// to join it rather than find it finished.
function hangFirstRead(bam: BamFile) {
  const stats = { reads: 0 }
  const inner = bam._readChunkFeatures.bind(bam)
  let started: () => void
  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })
  bam._readChunkFeatures = async (chunk, opts) => {
    stats.reads++
    if (stats.reads === 1) {
      started()
      // never resolves: the only way out is the owner's abort
      await new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    return inner(chunk, opts)
  }
  return { stats, firstStarted }
}

// lets queued microtasks and timers run, so a joining query reaches the
// in-flight map before we abort the owner
function tick() {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

test('a waiter survives the read owner aborting', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const { stats, firstStarted } = hangFirstRead(bam)

  const chunkCount = (await bam.blocksForRange('ctgA', 0, 5000)).length

  const aborter = new AbortController()
  const ownerP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: aborter.signal,
  })
  await firstStarted
  const waiterP = bam.getRecordsForRange('ctgA', 1, 5000)
  await tick()
  aborter.abort()

  await expect(ownerP).rejects.toThrow(/aborted/)
  const records = await waiterP
  expect(records.length).toBeGreaterThan(0)
  // the waiter joined the hung read and redid exactly it — one extra read, not
  // a whole second query's worth
  expect(stats.reads).toBe(chunkCount + 1)
})

test("a waiter's own abort still propagates", async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const { firstStarted } = hangFirstRead(bam)

  const aborter = new AbortController()
  const ownerP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: aborter.signal,
  })
  await firstStarted
  const waiterP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: aborter.signal,
  })
  await tick()
  aborter.abort()

  await expect(ownerP).rejects.toThrow(/aborted/)
  await expect(waiterP).rejects.toThrow(/aborted/)
})

// Only an abort earns a retry. A read that failed for any other reason failed
// for a reason the waiter would have hit too, so it must surface, not silently
// double the work.
test('a genuine read failure is not retried by waiters', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()

  const stats = { reads: 0 }
  let started: () => void
  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })
  let failFirst: () => void
  bam._readChunkFeatures = async () => {
    stats.reads++
    started()
    // never resolves: the test drives the failure via failFirst
    await new Promise((_resolve, reject) => {
      failFirst = () => {
        reject(new Error('boom'))
      }
    })
    throw new Error('unreachable')
  }

  const chunkCount = (await bam.blocksForRange('ctgA', 0, 5000)).length

  const aP = bam.getRecordsForRange('ctgA', 1, 5000)
  await firstStarted
  const bP = bam.getRecordsForRange('ctgA', 1, 5000)
  await tick()
  failFirst!()

  await expect(aP).rejects.toThrow(/boom/)
  await expect(bP).rejects.toThrow(/boom/)
  // one read per chunk and no retry: the second query joined and took the loss
  expect(stats.reads).toBe(chunkCount)
})
