# Caching

`BamFile` caches parsed chunks, the unit the BAM index points to, so overlapping
and adjacent queries reuse decompressed records. Three constructor options bound
the cache:

| option               | default | bounds                                              |
| -------------------- | ------- | --------------------------------------------------- |
| `maxCacheBytes`      | 1GB     | decompressed bytes retained by this file            |
| `cacheIdleTimeoutMs` | 3min    | how long an idle cache keeps its chunks             |
| `cacheBudget`        | none    | decompressed bytes retained by all files sharing it |

`clearFeatureCache()` drops everything immediately. `HtsgetFile` accepts the
same options but fills no cache, because it reads whole ticket blocks rather
than index chunks.

## `maxCacheBytes` never refuses a read

The cache accepts a chunk of any size, eviction skips reads in flight, and the
cache drops only values it has already returned. A budget can make a query
slower, never make one fail or come back short.

The default binds less often than its size suggests. On the deepest data we
measure (1000x coverage long reads, 240 windows over six laps), the cache
settles at 573MB across 60 entries and never evicts at the 1GB default. Treat
the ceiling as a limit for a session that pans forever, not as a parameter you
tune often.
([ADR 0016](../agent-docs/architecture-decision-records/0016-the-cache-does-not-grow-and-lru-stays.md))

Size `maxCacheBytes` above the working set of the several queries a pan makes,
not one. Below it, the cache evicts each chunk before the next pan can reuse it,
so the hit rate is zero, every pan decompresses every chunk again, and the
unevictable entries hold the memory anyway. At a 200MB budget on that same file
the cache holds exactly one entry, because one chunk there decompresses to
181MB. Pass `Infinity` and bound memory some other way if you cannot size above
it.
([ADR 0014](../agent-docs/architecture-decision-records/0014-size-the-chunk-cache-to-hold-several-queries.md),
[ADR 0016](../agent-docs/architecture-decision-records/0016-the-cache-does-not-grow-and-lru-stays.md))

## `cacheIdleTimeoutMs` frees an idle cache

The cache checks `maxCacheBytes` only when a read settles, so an idle cache sits
at whatever level it reached until the idle sweep frees it.

The clock runs from the last _read_ of a chunk, or from when its parse finished
if nothing has read it since, so panning back and forth over one region never
expires it, and a slow chunk still gets the full timeout in which to be reused.
On a pan that held 331MB, the cache held 0MB once idle. Pass `0` to disable.
([ADR 0015](../agent-docs/architecture-decision-records/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md),
[ADR 0016](../agent-docs/architecture-decision-records/0016-the-cache-does-not-grow-and-lru-stays.md))

## `cacheBudget` bounds a consumer with many files

`maxCacheBytes` applies per file, so it does not bound the total for a consumer
that opens one file per track. With three moderately deep alignment tracks over
eight windows, the caches retained 1109MB in total with none near its own 1GB
ceiling, enough to run a tab out of memory.

Pass one `SharedBudget` (from `@gmod/shared-read-cache`) per worker and hand it
to every file. A shared budget evicts the chunks of tracks nobody is looking at
to make room for the track the user is panning. Dividing `maxCacheBytes` by the
track count instead puts each track below its working set, as described above:
at 128MB a track re-reads every chunk on every pan.
([ADR 0018](../agent-docs/architecture-decision-records/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md))

## The cache options bound retained bytes, not peak memory

`maxCacheBytes`, `cacheIdleTimeoutMs` and `cacheBudget` bound retained
decompressed bytes, not the heap. On deep data the heap can be much larger:

- Up to six chunk reads run at once, and eviction skips reads in flight. On
  1000x long reads, 476MB is in flight before the cache retains anything.
- A query holds every chunk it parsed until it returns, whether or not the cache
  still does.
- The cache weighs an entry once, when its read settles, and records grow after
  that. `end`, `tags` and `NUMERIC_CIGAR` each memoize onto the record the first
  time you touch them, and a renderer touches them on every visible read. On
  `chr22_nanopore_subset.bam`, a chunk weighed at 20.4MB retained a further
  7.8MB (+38%) once its 383 records had been consumed.

Size these against what you want to keep, and bound total memory in code that
can see the whole process.

## A hit needs the same chunk span, not just the same bytes

The cache keys on the _merged_ chunk span a query resolved to, and merging
depends on the query, so a pan whose windows overlap decodes the same bytes
under two keys. One parse fully redoing another happens on shallow-to-moderate
short-read files whose bin chunks abut, including the volvox demo file, where
71% of what a twelve-window pan decompresses is redundant. It does not affect
deep long-read data at ordinary zoom.

Keying on raw chunks recovers it without costing bytes, but the fetch unit must
stay merged for the I/O reasons in
[optimizations.md](optimizations.md#choosing-and-fetching-chunks), so one fetch
would fill several cache entries, and entry counts on long-read files rise up to
7x (60 to 179). A canonical partition of the index has fewer entries than the
merged key and fills one entry per fetch, so `@gmod/shared-read-cache` needs no
change. Neither is built. Serving a subset from a cached superset looks cheaper
and is wrong.
[ADR 0019](../agent-docs/architecture-decision-records/0019-the-chunk-cache-key-slides-as-a-query-pans.md)
has the numbers and the design.

## The byte-range cache underneath

The options above bound the cache of parsed chunks. A byte-range cache on the
filehandle, such as
[@gmod/range-cache-filehandle](https://github.com/GMOD/range-cache-filehandle),
caches the compressed bytes underneath, so size the two together.

The byte-range cache receives a read only when the chunk cache misses, so its
defaults are deliberately looser: a 15-minute idle window against the 3 minutes
here. Once a chunk-cache entry expires, the byte-range cache keeps a re-read
from becoming a re-download (its
[tuning.md](https://github.com/GMOD/range-cache-filehandle/blob/main/docs/tuning.md)
has the measurement). It bounds memory per _module instance_ rather than per
file, so `cacheBudget` does not cover it, and no number on this page includes
it.

## Further reading

Every measurement above comes from an ADR in
[`agent-docs/architecture-decision-records/`](../agent-docs/architecture-decision-records/).
Beyond the ones linked here,
[0001](../agent-docs/architecture-decision-records/0001-chunk-cache-keeps-every-parsed-chunk.md)
covers what the chunk cache keeps, and
[0013](../agent-docs/architecture-decision-records/0013-the-batch-eviction-policy-does-not-transfer.md)
and
[0016](../agent-docs/architecture-decision-records/0016-the-cache-does-not-grow-and-lru-stays.md)
why it stays LRU rather than taking cram-js's batch eviction or growing on
demand.
