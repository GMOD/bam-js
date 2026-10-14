# Caching

`BamFile` caches parsed chunks, the unit the BAM index points to, so overlapping
and adjacent queries reuse decompressed records instead of re-fetching them.
Three constructor options bound that cache, and the table lists the question
each one answers.

| option               | default | question                                     |
| -------------------- | ------- | -------------------------------------------- |
| `maxCacheBytes`      | 1GB     | how much may _this file_ retain?             |
| `cacheIdleTimeoutMs` | 3min    | how long may it retain it while idle?        |
| `cacheBudget`        | none    | how much may _all my files together_ retain? |

`clearFeatureCache()` drops everything immediately. `HtsgetFile` accepts the
same options but fills no cache, because it reads whole ticket blocks rather
than index chunks.

## `maxCacheBytes` never refuses a read

The cache accepts a chunk of any size, eviction skips reads in flight, and the
cache drops only values it has already returned. The worst a budget can cost you
is a re-read: it can make a query slower, never make one fail or come back
short.

**The default binds less often than its size suggests.** On the deepest data we
measure (1000x coverage long reads, 240 windows over six laps), the cache
settles at 573MB across 60 entries and never evicts at the 1GB default. Treat
the ceiling as a limit for a session that pans forever, not as a parameter you
tune often.

**Don't pick a number between one query and several.** Below one query's working
set, the cache evicts each chunk before the next pan can reuse it. The hit rate
is then zero, every pan decompresses every chunk again, and the unevictable
entries hold the memory anyway. At a 200MB budget on that same file the cache
holds exactly one entry, because one chunk there decompresses to 181MB. Size
above the working set, or pass `Infinity` and bound memory some other way.
([ADR 0014](../agent-docs/architecture-decision-records/0014-size-the-chunk-cache-to-hold-several-queries.md))

## `cacheIdleTimeoutMs` is the only thing that gives memory back

The cache checks `maxCacheBytes` only when a read settles, so an idle one sits
at whatever level it reached. The idle sweep frees that memory, so a generous
ceiling limits a peak reached while panning rather than memory that a parked tab
holds indefinitely.

The clock runs from the last _read_ of a chunk, or from when its parse finished
if nothing has read it since, so panning back and forth over one region never
expires it, and a slow chunk still gets the full timeout in which to be reused.
On a pan that held 331MB, the cache held 0MB once idle. Pass `0` to disable.
([ADR 0015](../agent-docs/architecture-decision-records/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md))

## `cacheBudget` bounds a consumer with many files

`maxCacheBytes` applies per file, so it does not bound the total for a consumer
that opens one file per track. Three moderately deep alignment tracks browsing
eight windows retained 1109MB with no cache anywhere near its own 1GB ceiling,
enough to run a tab out of memory.

Pass one `SharedBudget` (from `@gmod/shared-read-cache`) per worker and hand it
to every file. A shared budget lets tracks nobody is looking at yield their
space to the one the user is panning. Dividing `maxCacheBytes` by the track
count instead puts each track below its working set, as described above: at
128MB a track re-reads every chunk on every pan.
([ADR 0018](../agent-docs/architecture-decision-records/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md))

## None of them bound peak memory

`maxCacheBytes`, `cacheIdleTimeoutMs` and `cacheBudget` bound retained
decompressed bytes, not the heap. On deep data the heap can be much larger:

- Up to six chunk reads run at once, and eviction skips reads in flight. On
  1000x long reads, 476MB is in flight before the cache retains anything.
- A query holds every chunk it parsed until it returns, whether or not the cache
  still does.
- The cache weighs an entry once, when its read settles, and records grow after
  that. `end`, `CIGAR` and `tags` each memoize onto the record the first time
  you touch them, and a renderer touches them on every visible read. We measured
  the result at +38% over the weighed size.

Size these against what you want to keep, and bound total memory in code that
can see the whole process.

## Records are shared

Overlapping queries share the records they return, so treat them as read-only. A
field you attach to a record appears on it for every other query that holds it.
([ADR 0006](../agent-docs/architecture-decision-records/0006-cached-records-are-shared-and-must-not-be-mutated.md))

## A hit needs the same chunk span, not just the same bytes

An entry's key is the _merged_ chunk span a query resolved to, and merging
depends on the query, so two overlapping pans can decode the same bytes under
two keys. That costs some short-read files real work and leaves deep long-read
data untouched; the fix is known and parked, with the numbers in
[optimizations.md](optimizations.md#what-is-left).

## The byte-range cache underneath

Everything above caches what a chunk _parsed to_. Underneath it, a byte-range
cache on the filehandle caches the compressed bytes a chunk was read from. Size
the two together; this page was measured against
[@gmod/range-cache-filehandle](https://github.com/GMOD/range-cache-filehandle).

A read reaches the byte-range cache only when the caches above miss, so its own
defaults are deliberately looser than these: a 15-minute idle window against the
3 minutes here. Once a chunk-cache entry expires, the byte-range cache is all
that keeps a re-read from becoming a re-download (its
[tuning.md](https://github.com/GMOD/range-cache-filehandle/blob/main/docs/tuning.md)
has the measurement). The byte-range cache also bounds memory per _module
instance_ rather than per file, so `cacheBudget` does not cover it, and it does
not appear in any number on this page.

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
