# Caching

`BamFile` caches parsed chunks — the unit the BAM index hands out — so
overlapping and adjacent queries reuse decompressed records instead of
re-fetching them. Three constructor options bound that cache, and each answers a
different question.

| option               | default | question                                     |
| -------------------- | ------- | -------------------------------------------- |
| `maxCacheBytes`      | 1GB     | how much may _this file_ retain?             |
| `cacheIdleTimeoutMs` | 3min    | how long may it retain it while idle?        |
| `cacheBudget`        | none    | how much may _all my files together_ retain? |

`clearFeatureCache()` drops everything immediately.

## `maxCacheBytes` is a ceiling, not a limit on what you can ask for

Nothing is ever refused for being too large. A chunk bigger than the whole
budget is still cached, a read in flight is never evicted, and eviction only
drops a value that has already been returned. The worst a budget can cost you is
a re-read: it can make a query slower, never make one fail or come back short.

**It binds less often than its size suggests.** On the deepest data we measure —
1000x coverage long reads, 240 windows over six laps — the cache settles at
573MB across 60 entries and never evicts at the 1GB default. Treat it as a
backstop against a session that pans forever, not as an everyday knob.

**Don't pick a number between one query and several.** Below one query's working
set the cache turns against you: each chunk is evicted before the next pan can
reuse it, so the hit rate is zero, the full decompress is paid every time, and
the unevictable entries hold the memory anyway. At a 200MB budget on that same
file the cache holds exactly one entry, because one chunk there decompresses to
181MB. Size above the working set, or pass `Infinity` and bound memory some
other way.
([ADR 0014](../agent-docs/adr/0014-size-the-chunk-cache-to-hold-several-queries.md))

## `cacheIdleTimeoutMs` is the only thing that gives memory back

`maxCacheBytes` is enforced when a read settles, so an idle cache stays at
whatever level it reached — and for a page that holds a `BamFile` for the life
of a track, that resting level is the number that actually matters. The idle
sweep is what makes a generous ceiling affordable, turning it into a peak
reached while panning rather than a level a parked tab holds indefinitely.

The clock runs from the last _read_ of a chunk, or from its parse landing if
nothing has read it since, so panning back and forth over one region never
expires it, and a slow chunk still gets the full timeout in which to be reused.
Measured on a pan that held 331MB: 0MB once idle. Pass `0` to disable.
([ADR 0015](../agent-docs/adr/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md))

## `cacheBudget` is what bounds a consumer with many files

`maxCacheBytes` is per file, which bounds nothing for a consumer that opens one
file per track. Three moderately deep alignment tracks browsing eight windows
retained 1109MB, with no cache anywhere near its own 1GB ceiling — the ceilings
were doing nothing at all, and the sum is what runs a tab out of memory.

Pass one `SharedBudget` (from `@gmod/shared-read-cache`) per worker and hand it
to every file. Dividing `maxCacheBytes` by the track count instead walks
straight into the cliff above — at 128MB a track re-reads every chunk on every
pan — whereas a shared budget lets tracks nobody is looking at yield their space
to the one being panned.
([ADR 0018](../agent-docs/adr/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md))

## None of them bound peak memory

They bound retained decompressed bytes, not the heap. On deep data the gap is
not small:

- Up to six chunk reads run at once and an in-flight read is never evicted — on
  1000x long reads that is 476MB in flight before retention holds anything.
- A query holds every chunk it parsed until it returns, whether or not the cache
  still does.
- An entry is weighed once, when its read settles, and records grow after that.
  `end`, `CIGAR` and `tags` each memoize onto the record the first time they are
  read — which is what a renderer does to every visible read — measured at +38%
  over the weighed size.

So size these against what you want to keep, and bound total memory somewhere
that can see the whole process.

## Records are shared

Returned records are cached and shared between overlapping queries, so treat
them as read-only: attaching your own fields to a record mutates it for every
other query holding it.
([ADR 0006](../agent-docs/adr/0006-cached-records-are-shared-and-must-not-be-mutated.md))

## Further reading

Every measurement above comes from an ADR in
[`agent-docs/adr/`](../agent-docs/adr/). Beyond the ones linked here,
[0001](../agent-docs/adr/0001-chunk-cache-keeps-every-parsed-chunk.md) covers
what the chunk cache keeps and
[0016](../agent-docs/adr/0016-the-cache-does-not-grow-and-lru-stays.md) why it
stays LRU.
