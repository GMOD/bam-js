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

## `maxCacheBytes` is a ceiling under load, not a limit on what you can ask for

Nothing is ever refused for being too large: a chunk bigger than the whole
budget is still cached, reads in flight are never evicted, and eviction only
drops a value that has already been returned once. The worst a budget can cost
you is a re-read. It can make a query slower; it can never make one fail or come
back short.

**It binds less often than its size suggests.** On the deepest data we measure —
1000x coverage long reads, 240 windows over six laps — the cache settles at
573MB across 60 entries and eviction never runs at the 1GB default. Treat it as
a backstop against a session that pans forever, not as an operating constraint.

**Don't pick a number between one query and several.** Below one query's working
set the cache inverts: each chunk is evicted before the next pan can reuse it,
so the hit rate is zero, the full re-decompress is paid every time, and the
unevictable entries retain the memory anyway. At a 200MB budget on that same
file the cache holds exactly one entry, because one chunk there decompresses to
181MB. Either size it above the working set or pass `Infinity` and bound memory
some other way. (ADR 0014)

## `cacheIdleTimeoutMs` is the only thing that gives memory back

`maxCacheBytes` is enforced when a read settles, so an idle cache sits at
whatever it reached and never lowers — and for a page that holds a `BamFile` for
the life of a track, that resting level is the number that actually matters. The
idle sweep is what makes a generous ceiling affordable, by turning it into a
peak under panning rather than a level a parked tab holds indefinitely.

The clock runs from the last _read_ of a chunk, or from its parse landing if
nothing has read it since, so panning back and forth over one region never
expires it and a slow chunk still gets the full timeout to be reused in.
Measured on a pan that held 331MB: 0MB once idle. Pass `0` to disable it.
(ADR 0015)

## `cacheBudget` is what bounds a consumer with many files

`maxCacheBytes` is per file, which is not a bound on a consumer that opens one
file per track. Three moderately deep alignment tracks browsing eight windows
measured 1109MB retained with no cache anywhere near its own 1GB ceiling — the
ceiling was not doing anything at all, and the sum is what a tab runs out of
memory on.

Pass one `SharedBudget` (from `@gmod/shared-read-cache`) per worker and hand it
to every file. Dividing `maxCacheBytes` by the track count instead reintroduces
the cliff above — at 128MB a track re-reads every chunk on every pan — whereas a
shared budget lets tracks nobody is looking at yield their space to the one
being panned. (ADR 0018)

## None of them bound peak memory

On deep data the gap is not small:

- Up to six chunk reads run at once and an in-flight read is never evicted. At
  181MB a chunk, that is ~476MB in flight before retention holds anything.
- A query holds every chunk it parsed until it returns, whether or not the cache
  still does.
- An entry is weighed once, when its read settles, and records grow after that.
  `end`, `CIGAR` and `tags` each memoize onto the record the first time they are
  read, which is what a renderer does to every visible read — measured at +38%
  over the weighed size.

So these are bounds on retained decompressed bytes, not on the heap. Size
against what you want to keep, and bound total memory at a level that can see
the whole process.

## Records are shared

Returned records are cached and shared between overlapping queries, so treat
them as read-only — attaching your own fields to a record mutates it for every
other query holding it. (ADR 0006)

## Further reading

The measurements behind all of the above live in
[`agent-docs/adr/`](../agent-docs/adr/), in particular ADRs 0001, 0006, 0014,
0015, 0016 and 0018.
