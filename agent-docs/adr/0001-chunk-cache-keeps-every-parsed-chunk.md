# ADR 0001 — The chunk cache keeps every chunk a query parses

Status: Accepted

## Context

`BamFile.chunkFeatureCache` caches parsed records per chunk, keyed on the
chunk's virtual-offset span. Alongside the byte-budget LRU there used to be a
second eviction rule, `evictOverlappingChunks`:

```ts
// Evict any cached chunks whose block range overlaps [minBlock, maxBlock]
private evictOverlappingChunks(minBlock: number, maxBlock: number) {
  for (const [key, entry] of this.chunkFeatureCache) {
    if (minBlock <= entry.maxBlock && maxBlock >= entry.minBlock) {
      this.chunkFeatureCache.delete(key)
    }
  }
}
```

It ran on every cache miss, before parsing the incoming chunk.

The rule is self-defeating, because **adjacent chunks share the BGZF block at
their boundary**. `optimizeChunks` merges spans until it hits a gap; the chunk
that ends at block P and the one that starts at block P are the same virtual
offset (`chunk[i].maxv == chunk[i+1].minv`), so the `<=`/`>=` test always fires
between neighbours. A query spanning N chunks therefore evicted chunk 1 while
parsing chunk 2, chunk 2 while parsing chunk 3, and so on — finishing with
exactly one entry cached no matter how many it had just paid to decompress. The
next query re-downloaded and re-inflated all of them.

On `test/data/chr22_nanopore_subset.bam` a 9-chunk query kept 7 entries; the two
missing ones were the largest (9.8 MB compressed of the 12.5 MB fetched), so
essentially the whole cost recurred on every pan.

The eviction predates the byte-budget LRU
(`8e6aa19 perf: bound the parsed-chunk cache by decompressed bytes`) and was the
original memory bound.

## Decision

Remove `evictOverlappingChunks`. The decompressed-byte LRU (`maxCacheBytes`,
default 100 MB) is the only bound.

## Consequences / rationale

- **Correctness is unaffected.** `_fetchChunkFeatures` iterates the _current
  query's_ chunk list and looks each key up; it never iterates the cache. A
  stale entry that overlaps the incoming one is therefore unreachable and cannot
  contribute duplicate records. Verified directly: record sets (by `fileOffset`)
  are identical with and without the eviction across 8 successive pans, with no
  duplicate `fileOffset` in any result.

- **Warm queries get dramatically faster.** A/B against the prior commit, both
  builds imported into one process, alternating order, min-of-9:

  | scenario                     | volvox | shortreads_300x (53k reads) | chr22_nanopore (757 long reads) |
  | ---------------------------- | ------ | --------------------------- | ------------------------------- |
  | pan ×6, warm                 | 1.06x  | 19.6x                       | 1373x                           |
  | narrow + tagfilter ×20, warm | 1.25x  | 9.3x                        | 33x                             |

- **Cold queries retain more memory.** A query now holds every chunk it parsed
  instead of one: 10.8 MB → 18.5 MB (shortreads), 8.2 MB → 24.4 MB (nanopore).
  Cold wall-clock is unchanged at the min (46.7 vs 47.6 ms) but the median is
  noisier from the extra allocation. This is the intended trade: a chunk dropped
  from the cache costs a re-download _and_ a re-decompress, and decompression is
  70–90% of a cold query (see ADR 0003). It also means `maxCacheBytes` is now
  actually exercised — under the old rule the cache sat at ~1 entry and the 100
  MB budget was nearly unreachable.

- **`fetchPairs` now goes through the cache too.** It called
  `_readChunkFeatures` directly, so a `viewAsPairs` query re-downloaded and
  re-inflated its mate chunks on every pan — and since mates are usually nearby,
  the mate chunk is typically the chunk already sitting in the cache (measured:
  the same 7.8 MB chunk re-inflated each time, warm query 41 → 20 ms). Both
  paths now share `_cachedChunkFeatures`. Niche in practice: jbrowse-components
  does its own chaining and never sets `viewAsPairs`.

## Rejected alternatives

- **Keep the eviction but compare full virtual offsets** (strict `minv < maxv`
  rather than block-position overlap). Fixes the neighbour-eviction case, but
  still drops cached entries whenever the merge geometry shifts — which is the
  remaining miss source below — for a memory bound the LRU already provides.

- **Cache per BGZF block instead of per chunk.** Would make reuse independent of
  merge geometry, but records straddle block boundaries, so a block cannot be
  parsed on its own. This is why the cache unit is the chunk.

## Known residual

`optimizeChunks` merges **per query**: as the window moves, `getLowestChunk`
filters a different set of leading chunks, so the merged span — and hence the
cache key — shifts even over data already in memory. Over a 15-window pan sweep
the chunk-lookup hit rate is 96% (nanopore) / 88% (shortreads); of the misses, 4
of 32 were spans _fully covered_ by earlier decompression, ~15 MB of 43 MB
re-inflated for nothing.

Two ways to close it, neither taken here:

- **Tile each ref's chunk list once** at index-parse time and have
  `blocksForRange` select intersecting tiles. Cache keys become
  query-independent, so panning always hits. Changes what bytes get fetched for
  remote files, so it needs a deliberate call rather than a perf-pass drive-by.
- **Superset lookup**: on a miss, reuse a cached entry whose span contains the
  requested one. Coordinate filtering in `appendInRange` makes the extra records
  harmless _in isolation_, but a cached span can bleed into a sibling chunk's
  range within the same query and duplicate records, so it needs `fileOffset`
  dedup to be safe.
