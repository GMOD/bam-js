# ADR 0015 — Reclaim the chunk cache when nothing is using it

Status: Accepted (raises `DEFAULT_MAX_CACHE_BYTES` 512 MB → 1 GB, adds a
3-minute idle timeout). Supersedes ADR 0014's number, not its reasoning.

## Context

ADR 0014 raised the budget to 512 MB because a budget below one query's working
set caches nothing at all — it evicts each chunk before the next pan reuses it,
so the hit rate is zero and the memory is retained anyway. That analysis holds.
The number it landed on was still a compromise, and against the wrong
constraint.

512 MB was chosen to be defensible as a **resting** level, because it is one:
the budget is enforced when a read settles, so an idle cache stays wherever it
got to and never gives anything back. jbrowse memoizes one `BamFile` per adapter
for the life of the track (`BamAdapter.ts:23-49`) and passes no budget, so a tab
parked on a deep region holds its whole last view until the track is closed,
times every track open. Every megabyte of ceiling was therefore a megabyte a
parked tab might sit on forever, which is what kept the number down — and 512 MB
still leaves `1000x.longread` short of the 800 MB where it stops thrashing (ADR
0014's table).

The constraint is only real because nothing reclaims on idle. Remove that and
the ceiling stops being a resting level, and can be sized for panning instead.

## Decision

- `@gmod/shared-read-cache` gains `idleTimeoutMs`, which drops an entry once
  nothing has read it for that long (added in 1.4.0).
- `DEFAULT_CACHE_IDLE_TIMEOUT_MS = 3 * 60 * 1000`, overridable per `BamFile` via
  `cacheIdleTimeoutMs`; `0` opts out.
- `DEFAULT_MAX_CACHE_BYTES` 512 MB → **1 GB**, which clears the deepest case
  measured — a six-window pan on `1000x.longread` peaks at 569 MB held.

The two are one decision. The ceiling is affordable _because_ it is now a peak
under active panning rather than a level a parked tab holds indefinitely.

## Consequences / rationale

- **Idle from last read, not from fill.** An absolute expiry would throw away a
  chunk fetched once and read every second, which is the opposite of what a
  cache wants. Panning back and forth over one region never expires it; a test
  pins this at 160s of elapsed time against a 60s timeout with zero re-reads.

- **Three minutes, not seconds.** The target is a user who has gone away, not
  one reading the screen in front of them. A pan back a minute later should
  still hit. Shorter would reintroduce the ADR 0014 pathology on a timer rather
  than on a byte count — the same total-miss behaviour, harder to see.

- **Still bounded under load.** A ceiling is what stops a long panning session
  growing without limit; the idle sweep only reclaims what has gone quiet. bam
  does not go unbounded, for the same reason ADR 0014 gave: this default is the
  only thing between jbrowse and unbounded growth, since it passes no budget.

- **The sweep costs nothing when idle**, which is the property that makes it
  safe in a library. The timer runs only while there is something it could
  reclaim: armed by the first read to **settle**, stopped by the first sweep
  that finds no settled entry left. So a `BamFile` nobody is using holds no
  timer — and there is no `dispose()` for a consumer to forget. It is `unref`ed
  where that exists, so it can never be why a Node script fails to exit.

  _Corrected after the fact._ As first written, this bullet said the timer
  started with the first **entry** and stopped when the cache **emptied**, and
  that is not the same claim. An in-flight read is never swept, so a read that
  never settles — a stalled fetch on a dead connection, which is exactly when a
  reader gives up and closes the track — held `entries.size` above zero and left
  the timer ticking forever. A live interval is a GC root: it roots the cache,
  and the cache roots the `BamFile` through its `fill` closure, so that one hung
  read pinned the whole graph and every chunk in it indefinitely. Arming on a
  settle and stopping on "nothing settled left" is what makes the claim above
  true rather than merely intended.

- **Peak memory is still not bounded by this**, and the `maxCacheBytes` docs
  still say so. In-flight reads are unevictable and six run at once; on
  `1000x.longread` that alone is 476 MB.

## Rejected alternatives

- **Unbounded plus the idle timeout, no ceiling.** Tempting, and the package's
  own default. But three minutes of continuous panning across deep data has no
  bound, and continuous panning is exactly when nothing is idle enough to sweep.
  The ceiling is what covers the case the timeout cannot.

- **A shorter timeout with a lower ceiling.** Same total-miss failure as ADR
  0014, expressed in time instead of bytes: a 20-second timeout on a user who
  reads for 30 seconds between pans re-decompresses everything, every pan.

- **Sweeping lazily inside `get()` instead of on a timer.** Costs nothing and
  reclaims nothing — it can only fire when something is calling in, and the case
  this exists for is precisely when nothing is.
