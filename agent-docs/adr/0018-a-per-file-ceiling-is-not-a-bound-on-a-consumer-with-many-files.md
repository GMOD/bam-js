# ADR 0018 — A per-file ceiling is not a bound on a consumer with many files

Status: Accepted (adds `cacheBudget`, an opt-in budget shared across `BamFile`s;
no default change). Extends ADR 0015/0016 rather than superseding them.

## Context

ADR 0015 set `DEFAULT_MAX_CACHE_BYTES` to 1 GB, sized so a six-window pan on the
deepest fixture measured (569 MB) never thrashes. ADR 0016 then audited
retention and found no growth. Both are about **one file**.

jbrowse holds one `BamFile` per adapter config for the life of the track and
passes no budget, so the ceiling is per open track. What that costs was never
measured. Three moderately deep tracks browsing eight 50 kb windows:

| step | 1000x.shortread | 200x.longread | 200x.shortread | aggregate | RSS     |
| ---: | --------------: | ------------: | -------------: | --------: | ------- |
|    0 |          192 MB |         72 MB |          39 MB |    303 MB | 567 MB  |
|    3 |          384 MB |         72 MB |         154 MB |    610 MB | 994 MB  |
|    7 |          675 MB |        124 MB |         310 MB |   1109 MB | 1665 MB |

Still climbing, and **no cache is anywhere near its own 1 GB ceiling** — so not
one byte of that was the budget doing anything. Nothing bounded it. The only
reclamation available was `DEFAULT_CACHE_IDLE_TIMEOUT_MS`, which by construction
does nothing while the reader is browsing.

Scaled by track count, on a six-window browse:

| tracks | per-file 1 GB each | shared 1 GB total |
| -----: | -----------------: | ----------------: |
|      2 |   343 MB / 606 RSS |  343 MB / 703 RSS |
|      4 |  885 MB / 1460 RSS | 885 MB / 1529 RSS |
|      6 | 1442 MB / 2250 RSS | 989 MB / 1984 RSS |

## Rejected: divide the ceiling by the track count

The obvious fix, and it walks straight into the cliff the per-file number exists
to avoid. Three tracks, browse then pan back, counting refills on the revisit:

| per-file budget | aggregate held | revisit refills |
| --------------- | -------------: | --------------: |
| 128 MB          |         348 MB |         **101** |
| 256 MB          |         609 MB |              30 |
| 512 MB          |         918 MB |               8 |
| 1024 MB (ship)  |        1109 MB |               0 |

The cold pass over the same ground was 98 refills, so the 128 MB row — what
eight tracks sharing a gigabyte would each get — is **worse than having no cache
at all**. An equal split cannot work, because the divisor is the thing that
makes each share too small.

## Decision

`cacheBudget`, a `SharedBudget` from `@gmod/shared-read-cache` that several
files hold jointly, evicting globally least-recently-used across all of them.
Opt-in; `maxCacheBytes` keeps its 1 GB default and its meaning.

At an equal aggregate ceiling the shared budget beats the split on both axes —
1024 MB held and 4 refills, against 773 MB held and 16 refills — because a
member yields only what is globally least-recently-used. Tracks nobody is
looking at hand their space to the one being panned, so the active track keeps a
whole working set however many tracks are open. That is precisely what an equal
split cannot do.

## Consequences / rationale

- **Inert until it binds.** At 2 and 4 tracks the shared rows above are
  identical to the per-file rows, refill for refill. It is a ceiling, not an
  allocation, and it changes nothing for a consumer that was never near it.

- **Bounding memory costs re-reads, and the number is not small.** Six tracks
  under a shared gigabyte cost 33 revisit refills against 0. That is the trade
  being bought, and it should be stated rather than discovered: this lowers the
  ceiling a browsing session can reach, it does not make the working set
  smaller. Below the working set the ADR 0014 cliff is waiting, shared budget or
  not — at 256 MB across three tracks the cold pass itself rose from 70 refills
  to 110.

- **RSS moves less than retention does.** 1442 → 989 MB held is 31%; 2250 → 1984
  MB RSS is 12%. The rest is transient — `@gmod/bgzf-filehandle`'s grow-only
  module-global wasm memory among it — and no cache budget touches that.

- **Members are held weakly.** A budget outliving a closed track and keeping its
  `BamFile` reachable would be a leak of exactly the kind this exists to
  prevent; jbrowse reclaims a closed track by dropping the last strong reference
  to its adapter. The budget holds a `WeakRef` and the member's last known
  weight beside it, crediting it back when it finds the member collected. There
  is no `unregister` for a consumer to forget.

- **Not a default.** A default shared budget would need a scope to be shared
  _within_, and this library has no idea whether it is one file in a script or
  forty in a worker pool. The consumer that knows — one budget per worker,
  handed to every file — is the one that should say so.

## What this does NOT establish

Peak memory is still unbounded, on the same grounds as ADR 0015: reads in flight
are never evicted, six run at once, and a query holds every chunk it parsed
until it returns. A shared budget bounds the sum of what is _retained_, which is
what grows while a reader browses.

## Methodology

`~/src/jb2bench/data`, `LocalFile`, `cacheIdleTimeoutMs: 0` so the idle sweep
cannot be mistaken for the budget working. Retention is the sum of
`chunkFeatureCache.totalSize`; refills count `_readChunkFeatures` calls. Working
sets must be measured with the budget off — see ADR 0013's correction note.
