import { expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'

// Parsed records are views into their chunk's decompressed buffer, so a cached
// entry pins that whole buffer. The cache therefore budgets decompressed bytes
// rather than counting entries, which would leave memory unbounded.
test('chunk cache stays within its byte budget', async () => {
  // 32MB, not 4MB: one of this file's chunks inflates to ~11MB, and the cache
  // deliberately keeps a single over-budget chunk (see the next test). A budget
  // below one chunk therefore only ever exercises the size === 1 escape hatch,
  // never the eviction loop this test is about.
  const maxCacheBytes = 32 * 1024 * 1024
  const bam = new BamFile({ bamPath: 'test/data/out.bam', maxCacheBytes })
  await bam.getHeader()

  // out.bam's reference '1' holds data over 0-1,015,808 only. Stepping by 2Mb,
  // as this used to, put 11 of its 12 queries outside the covered range, where
  // blocksForRange returns nothing and the query is a no-op — so the loop
  // exercised one query and the budget was never really under pressure.
  for (let i = 0; i < 12; i++) {
    const start = i * 80_000
    await bam.getRecordsForRange('1', start, start + 400_000)
  }

  const cache = bam.chunkFeatureCache
  expect(cache.maxBytes).toBe(maxCacheBytes)
  // more than one entry, i.e. the eviction loop rather than the escape hatch
  expect(cache.size).toBeGreaterThan(1)
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

// A query spanning several chunks used to evict cached entries whose *block*
// range overlapped the incoming one. Adjacent chunks share the BGZF block at
// their boundary (chunk A's maxv and chunk B's minv are the same virtual
// offset), so every multi-chunk query threw away the chunks it had just parsed
// and the next query re-decompressed all of them.
test('a multi-chunk query keeps every chunk it parsed', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()
  const stats = countChunkReads(bam)

  const chunks = await bam.blocksForRange('22', 16_449_999, 16_490_000)
  expect(chunks.length).toBeGreaterThan(1)

  await bam.getRecordsForRange('22', 16_450_000, 16_490_000)
  // Every chunk the query *read* is still cached, which is the eviction
  // property under test. Not necessarily every chunk blocksForRange returned:
  // the query stops once a chunk proves it lies past the range.
  expect(stats.reads).toBeGreaterThan(1)
  expect(bam.chunkFeatureCache.size).toBe(stats.reads)
})

// The BAI linear index degenerates on long reads: one read spanning a wide span
// pins the lower bound near the start of the file, so optimizeChunks filters
// nothing and a narrow window inherits every chunk of every overlapping bin.
// Chunks are file-ordered and the BAM is coordinate-sorted, so the first chunk
// found to start past the query proves every later one does too (ADR 0010).
test('a query stops reading once a chunk lies past its range', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()
  const stats = countChunkReads(bam)

  const chunks = await bam.blocksForRange('22', 16_000_000, 16_010_000)
  expect(chunks.length).toBeGreaterThan(10)

  const records = await bam.getRecordsForRange('22', 16_000_000, 16_010_000)
  expect(records.length).toBe(0)
  // far fewer reads than the index handed us chunks
  expect(stats.reads).toBeLessThan(chunks.length)
})

// The property that makes the stop safe to have at all. An earlier attempt
// checked it inside the work-stealing pool, where a warm cache resolved chunks
// faster than any worker could publish the stop — so a repeat of the same query
// read MORE chunks than the first, and the cache grew on every pan. The barrier
// after the first batch makes the decision a function of chunk order alone.
test('a repeated query reads no more chunks the second time', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()
  const stats = countChunkReads(bam)

  await bam.getRecordsForRange('22', 16_000_000, 16_010_000)
  const cold = stats.reads
  expect(cold).toBeGreaterThan(0)

  await bam.getRecordsForRange('22', 16_000_000, 16_010_000)
  expect(stats.reads).toBe(cold)
})

// The stop must not lose records. Checks a narrow window against the same reads
// found by a wide query, which resolves to a different chunk set and stops in a
// different place — so the two paths agree only if the stop is sound.
test('an early-stopped query returns the same records as a wide one', async () => {
  const bam = new BamFile({ bamPath: 'test/data/chr22_nanopore_subset.bam' })
  await bam.getHeader()

  const min = 16_500_000
  const max = 16_550_000
  const narrow = await bam.getRecordsForRange('22', min, max)
  const wide = await bam.getRecordsForRange('22', 16_000_000, 16_800_000)
  const expected = wide.filter(r => r.start < max && r.end >= min)

  expect(narrow.length).toBeGreaterThan(0)
  expect(narrow.map(r => r.fileOffset).sort()).toEqual(
    expected.map(r => r.fileOffset).sort(),
  )
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
  let started!: () => void
  let release!: () => void
  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  bam._readChunkFeatures = async (chunk, opts) => {
    stats.reads++
    if (stats.reads === 1) {
      started()
      // Parked until the test lets it go, or until the read is cancelled. The
      // signal here is the *shared* one, which now fires only once every caller
      // waiting on this read has aborted — so a test that leaves a waiter alive
      // has to release the read itself rather than expecting an abort to.
      await new Promise<void>((resolve, reject) => {
        void released.then(resolve)
        opts.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    return inner(chunk, opts)
  }
  return {
    stats,
    firstStarted,
    release: () => {
      release()
    },
  }
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
  const { stats, firstStarted, release } = hangFirstRead(bam)

  const chunkCount = (await bam.blocksForRange('ctgA', 0, 5000)).length

  const aborter = new AbortController()
  const waiter = new AbortController()
  const ownerP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: aborter.signal,
  })
  await firstStarted
  // its own live signal, so this tests the reference count rather than the
  // separate rule that a signal-free caller pins the read
  const waiterP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: waiter.signal,
  })
  await tick()
  aborter.abort()
  // the waiter has not given up, so the read it joined is not cancelled and is
  // still sitting there waiting to be let go
  release()

  await expect(ownerP).rejects.toThrow(/abort/i)
  const records = await waiterP
  expect(records.length).toBeGreaterThan(0)
  expect(waiter.signal.aborted).toBe(false)
  // No re-read at all. The read ran to completion because one caller giving up
  // is not every caller giving up. This used to assert chunkCount + 1: the
  // waiter inherited the owner's failure and redid the read it had joined.
  expect(stats.reads).toBe(chunkCount)
})

test('a read is cancelled once every waiter has aborted', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const { firstStarted } = hangFirstRead(bam)

  const owner = new AbortController()
  const waiter = new AbortController()
  const ownerP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: owner.signal,
  })
  await firstStarted
  const waiterP = bam.getRecordsForRange('ctgA', 1, 5000, {
    signal: waiter.signal,
  })
  await tick()

  // the other half of the contract: nobody is left who wants these bytes, so
  // the read is cancelled rather than run to completion and thrown away. The
  // hung read is never released here — the abort is what unblocks it.
  owner.abort()
  waiter.abort()

  await expect(ownerP).rejects.toThrow(/abort/i)
  await expect(waiterP).rejects.toThrow(/abort/i)
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

// maxBytes is reachable on the public chunkFeatureCache, so lowering it is how
// a caller sheds memory under pressure. It has to take effect immediately: as
// a plain field it did nothing until the next chunk read happened to run the
// eviction loop, which on an idle viewer is never.
test('lowering maxBytes evicts immediately', async () => {
  const bam = new BamFile({ bamPath: 'test/data/out.bam' })
  await bam.getHeader()
  for (let i = 0; i < 12; i++) {
    const start = i * 80_000
    await bam.getRecordsForRange('1', start, start + 400_000)
  }

  const cache = bam.chunkFeatureCache
  expect(cache.size).toBeGreaterThan(1)

  cache.maxBytes = 1024
  expect(cache.maxBytes).toBe(1024)
  // the size > 1 escape hatch keeps the last chunk whatever the budget
  expect(cache.size).toBe(1)
})
