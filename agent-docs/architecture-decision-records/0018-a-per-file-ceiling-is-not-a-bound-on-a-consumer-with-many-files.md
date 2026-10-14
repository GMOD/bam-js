# ADR 0018 — A per-file ceiling is not a bound on a consumer with many files

Status: Accepted (adds `cacheBudget`, an opt-in budget shared across `BamFile`s;
no default change). Extends ADR 0015/0016 rather than superseding them.

## Context

ADR 0015 set `DEFAULT_MAX_CACHE_BYTES` to 1 GB, sized so a six-window pan on the
deepest fixture measured (569 MB) never thrashes. ADR 0016 then audited
retention and found no growth. Both are about **one file**.

jbrowse holds one `BamFile` per adapter config for the life of the track and
passes no budget, so the ceiling is per open track. We had not measured what
that costs, so we browsed eight 50 kb windows on three moderately deep tracks:

| step | 1000x.shortread | 200x.longread | 200x.shortread | aggregate | RSS     |
| ---: | --------------: | ------------: | -------------: | --------: | ------- |
|    0 |          192 MB |         72 MB |          39 MB |    303 MB | 567 MB  |
|    3 |          384 MB |         72 MB |         154 MB |    610 MB | 994 MB  |
|    7 |          675 MB |        124 MB |         310 MB |   1109 MB | 1665 MB |

The aggregate is still climbing at step 7, and **no cache is anywhere near its
own 1 GB ceiling**, so the budget evicted none of that memory and no other
mechanism bounded it. The only reclamation available was
`DEFAULT_CACHE_IDLE_TIMEOUT_MS`, which by construction reclaims nothing while
the reader is browsing.

The next table scales the track count on a six-window browse:

| tracks | per-file 1 GB each | shared 1 GB total |
| -----: | -----------------: | ----------------: |
|      2 |   343 MB / 606 RSS |  343 MB / 703 RSS |
|      4 |  885 MB / 1460 RSS | 885 MB / 1529 RSS |
|      6 | 1442 MB / 2250 RSS | 989 MB / 1984 RSS |

## Rejected: divide the ceiling by the track count

Dividing the ceiling is the obvious fix, and it brings back the refill blow-up
that the per-file number was sized to avoid (ADR 0014). With three tracks, we
browsed and then panned back, counting refills on the revisit:

| per-file budget | aggregate held | revisit refills |
| --------------- | -------------: | --------------: |
| 128 MB          |         348 MB |         **101** |
| 256 MB          |         609 MB |              30 |
| 512 MB          |         918 MB |               8 |
| 1024 MB (ship)  |        1109 MB |               0 |

The cold pass over the same ground took 98 refills, so the 128 MB row is **worse
than having no cache at all**. 128 MB is what each of eight tracks sharing a
gigabyte would get. An equal split cannot work, because dividing by the track
count shrinks each share below a working set.

## Decision

Add `cacheBudget`, a `SharedBudget` from `@gmod/shared-read-cache` that several
files hold jointly and that evicts the globally least-recently-used entry across
all of them. The budget is opt-in; `maxCacheBytes` keeps its 1 GB default and
its meaning.

At an equal aggregate ceiling, the shared budget does better than the split on
both measures (1024 MB held and 4 refills, against 773 MB held and 16 refills),
because it evicts from a member only what is globally least-recently-used. It
evicts the entries of tracks nobody is looking at first, so the track being
panned keeps a whole working set however many tracks are open. An equal split
cannot do that.

## Consequences / rationale

- **The shared budget changes nothing until it binds.** At 2 and 4 tracks the
  shared rows above are identical to the per-file rows, refill for refill. The
  budget is a ceiling, not an allocation, so a consumer that was never near it
  sees no change.

- **A bound on memory costs re-reads, and the number is not small.** Six tracks
  under a shared gigabyte cost 33 revisit refills against 0. We accept that
  trade-off. The budget lowers the ceiling a browsing session can reach, but it
  does not make the working set smaller. Below the working set, refills climb as
  ADR 0014 measured, with or without a shared budget. At 256 MB across three
  tracks, the cold pass itself rose from 70 refills to 110.

- **RSS moves less than retention does.** 1442 → 989 MB held is 31%; 2250 → 1984
  MB RSS is 12%. The rest is transient, with `@gmod/bgzf-filehandle`'s grow-only
  module-global wasm memory among it, and no cache budget affects it.

- **The budget holds members weakly.** A budget that outlived a closed track and
  kept its `BamFile` reachable would cause exactly the kind of leak it is meant
  to prevent, because jbrowse reclaims a closed track by dropping the last
  strong reference to its adapter. The budget stores a `WeakRef` to each member
  with the member's last known weight, and credits that weight back when it
  finds the member collected. A consumer therefore has no `unregister` to
  forget.

- **The shared budget is not a default.** A default shared budget would need a
  scope to be shared _within_, and the library cannot tell whether it serves one
  file in a script or forty in a worker pool. The consumer knows, so the
  consumer should create the budget, one per worker, and hand it to every file.

## What this does not establish

Peak memory is still unbounded, on the same grounds as ADR 0015: reads in flight
are never evicted, six run at once, and a query holds every chunk it parsed
until it returns. A shared budget bounds the sum of what is _retained_, which is
what grows while a reader browses.

## Methodology

The runs use `~/src/jb2bench/data` and `LocalFile`, with `cacheIdleTimeoutMs: 0`
so the idle sweep cannot be mistaken for the budget working. Retention is the
sum of `chunkFeatureCache.totalSize`; refills count `_readChunkFeatures` calls.
Measure working sets with the budget off (see ADR 0013's correction note).
