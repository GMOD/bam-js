# Caching

`BamFile` caches each parsed chunk, the unit of data the BAM index points to, so
overlapping and adjacent queries reuse decompressed records instead of fetching
them again. Three constructor options bound that cache, and the table lists the
question each one answers.

| option               | default | question                                     |
| -------------------- | ------- | -------------------------------------------- |
| `maxCacheBytes`      | 1GB     | how much may _this file_ retain?             |
| `cacheIdleTimeoutMs` | 3min    | how long may it retain it while idle?        |
| `cacheBudget`        | none    | how much may _all my files together_ retain? |

`clearFeatureCache()` drops everything immediately. `HtsgetFile` accepts the
same options but keeps no cache, because it reads whole ticket blocks rather
than index chunks.

## `maxCacheBytes` never refuses a read

The cache accepts a chunk of any size, eviction skips reads in flight, and the
cache drops only values it has already returned. A small budget therefore costs
at most a re-read: it can make a query slower, but never make one fail or return
fewer records.

**The default rarely evicts.** On the deepest data we measure (1000x coverage
long reads, 240 windows over six laps), the cache levels off at 573MB across 60
entries and never evicts at the 1GB default. The ceiling is a limit for a
session that pans indefinitely, not a parameter you need to tune often.

**Don't pick a number between one query and several.** Below one query's working
set, the cache evicts each chunk before the next pan can reuse it. The hit rate
is then zero, every pan decompresses every chunk again, and the entries that
eviction cannot drop hold the memory anyway. At a 200MB budget on that same file
the cache holds exactly one entry, because one chunk there decompresses to
181MB. Size above the working set, or pass `Infinity` and bound memory some
other way.
([ADR 0014](../agent-docs/architecture-decision-records/0014-size-the-chunk-cache-to-hold-several-queries.md))

## `cacheIdleTimeoutMs` is the only option that frees memory

The cache checks `maxCacheBytes` only when a read settles, so an idle cache
stays at whatever size it reached. The idle sweep frees that memory, so a
generous ceiling limits a peak reached while panning rather than memory that a
parked tab holds indefinitely.

The timeout counts from the last _read_ of a chunk, or from when its parse
finished if nothing has read it since. Panning back and forth over one region
therefore never expires the chunk, and a slow chunk still gets the full timeout
to be reused. On a pan that held 331MB, the cache held 0MB once idle. Pass `0`
to disable the sweep.
([ADR 0015](../agent-docs/architecture-decision-records/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md))

## `cacheBudget` bounds a consumer with many files

`maxCacheBytes` applies per file, so it does not bound the total for a consumer
that opens one file per track. Three moderately deep alignment tracks browsing
eight windows retained 1109MB while no single cache came near its 1GB ceiling,
and a total like that can run a tab out of memory.

Create one `SharedBudget` (from `@gmod/shared-read-cache`) per worker and pass
it to every file. A shared budget lets the tracks nobody is looking at give up
their space to the track the user is panning. Dividing `maxCacheBytes` by the
track count instead puts each track below its working set, as described above:
at 128MB a track re-reads every chunk on every pan.
([ADR 0018](../agent-docs/architecture-decision-records/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md))

## Peak memory

`maxCacheBytes`, `cacheIdleTimeoutMs` and `cacheBudget` bound the decompressed
bytes the cache retains, not the heap. On deep data the heap can be much larger:

- Up to six chunk reads run at once, and eviction skips reads in flight. On
  1000x long reads, 476MB is in flight before the cache retains anything.
- A query holds every chunk it parsed until it returns, whether or not the cache
  still does.
- The cache weighs an entry once, when its read settles, and records grow after
  that. `end`, `CIGAR` and `tags` each memoize onto the record the first time
  you read them, and a renderer accesses them on every visible read. We measured
  the result at +38% over the weighed size.

Size these options for the data you want to keep, and bound total memory in code
that can see the whole process.

## Shared records

Overlapping queries return the same record objects, so treat records as
read-only. A field you attach to a record appears on it for every other query
that holds it.
([ADR 0006](../agent-docs/architecture-decision-records/0006-cached-records-are-shared-and-must-not-be-mutated.md))

## Cache keys

An entry's key is the _merged_ chunk span that the query resolved to, and
merging depends on the query, so two overlapping pans can decode the same bytes
under two keys. The duplicate decoding adds real work on some short-read files
and none on deep long-read data. The fix is known and parked, and
[optimizations.md](optimizations.md#what-is-left) has the numbers.

## The byte-range cache underneath

The options above bound a cache of what each chunk _parsed to_. A byte-range
cache on the filehandle, underneath it, caches the compressed bytes the chunks
were read from. Size the two caches together; this page was measured against
[@gmod/range-cache-filehandle](https://github.com/GMOD/range-cache-filehandle).

A read reaches the byte-range cache only when the caches above miss, so its
defaults are looser than these: a 15-minute idle timeout against the 3 minutes
here. Once a chunk-cache entry expires, the byte-range cache is all that keeps a
re-read from becoming a re-download (its
[tuning.md](https://github.com/GMOD/range-cache-filehandle/blob/main/docs/tuning.md)
has the measurement). The byte-range cache also bounds memory per _module
instance_ rather than per file, so `cacheBudget` does not cover it and no number
on this page includes it.

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
