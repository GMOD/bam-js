# ADR 0015 — Reclaim the chunk cache when nothing is using it

Status: Accepted (raises `DEFAULT_MAX_CACHE_BYTES` 512 MB → 1 GB, adds a
3-minute idle timeout). Supersedes ADR 0014's number, not its reasoning.

## Context

ADR 0014 raised the budget to 512 MB because a budget below one query's working
set caches nothing at all. Such a budget evicts each chunk before the next pan
reuses it, so the hit rate is zero and the memory is retained anyway. That
analysis still holds, but the 512 MB figure was a compromise, made against the
wrong constraint.

We chose 512 MB to be defensible as a **resting** level, because the ceiling is
one. The cache enforces the budget when a read settles, so an idle cache stays
wherever it got to and never gives anything back. jbrowse memoizes one `BamFile`
per adapter for the life of the track (`BamAdapter.ts:23-49`) and passes no
budget, so a tab parked on a deep region holds its whole last view until the
track is closed, for every open track. Every megabyte of ceiling was therefore a
megabyte a parked tab might sit on forever, which kept the number down. Even so,
512 MB leaves `1000x.longread` short of the 800 MB where it stops thrashing (ADR
0014's table).

The resting-level constraint exists only because the cache reclaims nothing when
idle. With idle reclamation, the ceiling stops being a resting level and can be
sized for panning instead.

## Decision

- `@gmod/shared-read-cache` gains `idleTimeoutMs`, which drops an entry once
  nothing has read it for that long (added in 1.4.0).
- `DEFAULT_CACHE_IDLE_TIMEOUT_MS = 3 * 60 * 1000`, overridable per `BamFile` via
  `cacheIdleTimeoutMs`; `0` opts out.
- `DEFAULT_MAX_CACHE_BYTES` 512 MB → **1 GB**, which clears the deepest case
  measured: a six-window pan on `1000x.longread` peaks at 569 MB held.

The ceiling and the timeout are one decision. The ceiling is affordable
_because_ it is now a peak under active panning rather than a level a parked tab
holds indefinitely.

## Consequences / rationale

- **The timeout counts from the last read, not from the fill.** An absolute
  expiry would throw away a chunk fetched once and read every second, which
  defeats the cache. Panning back and forth over one region never expires the
  chunk; a test checks this over 160s of elapsed time against a 60s timeout,
  with zero re-reads.

- **The timeout is three minutes, not seconds.** The target is a user who has
  gone away, not one reading the screen in front of them, and a pan back a
  minute later should still hit. A shorter timeout would reintroduce ADR 0014's
  total misses, triggered by a timer rather than a byte count, and harder to
  see.

- **The cache stays bounded under load.** The ceiling stops a long panning
  session from growing without limit, and the idle sweep reclaims only entries
  that no read has touched for the timeout. bam keeps a finite ceiling for the
  reason ADR 0014 gave: jbrowse passes no budget, so without this default the
  cache would grow without bound.

- **An idle cache runs no timer**, which makes the sweep safe in a library. The
  timer runs only while it has something it could reclaim: the first read to
  **settle** arms it, and the first sweep that finds no settled entry left stops
  it. A `BamFile` that nobody is using therefore holds no timer, and a consumer
  has no `dispose()` to forget. The timer is `unref`ed where that exists, so it
  can never be why a Node script fails to exit.

  _Corrected after the fact._ As first written, this bullet said the timer
  started with the first **entry** and stopped when the cache **emptied**, and
  that is not the same claim. The sweep never removes an in-flight read, so a
  read that never settled held `entries.size` above zero and left the timer
  ticking forever. A stalled fetch on a dead connection is such a read, and it
  happens exactly when a reader gives up and closes the track. A live interval
  is a GC root: it roots the cache, and the cache roots the `BamFile` through
  its `fill` closure, so that one hung read pinned the whole graph and every
  chunk in it indefinitely. Because the timer now arms on a settle and stops
  when no settled entry is left, the claim above holds.

- **The idle timeout does not bound peak memory either**, and the
  `maxCacheBytes` docs still say so. In-flight reads are unevictable and six run
  at once; on `1000x.longread` those six alone hold 476 MB.

## Rejected alternatives

- **Unbounded plus the idle timeout, no ceiling.** The option is tempting, and
  unbounded is the package's own default. But three minutes of continuous
  panning across deep data has no bound, and during continuous panning no entry
  is idle long enough to sweep. The ceiling covers the case the timeout cannot.

- **A shorter timeout with a lower ceiling.** This option fails with ADR 0014's
  total misses, triggered by time instead of bytes. A 20-second timeout on a
  user who reads for 30 seconds between pans re-decompresses everything on every
  pan.

- **Sweeping lazily inside `get()` instead of on a timer.** A lazy sweep adds no
  timer and reclaims nothing, because it runs only when a caller is reading, and
  an idle cache has no caller.
