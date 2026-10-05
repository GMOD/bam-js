# ADR 0019 — The chunk cache key slides as a query pans

Status: **Parked, but the two costs that parked it now have an answer.** See "A
key that does not slide" below: a canonical partition has fewer entries than the
merged key ships today, and fills one cache entry per fetch, so
`@gmod/shared-read-cache` needs nothing and this becomes a one-repo change. Not
built; one measured regression is the open question.

Records what the waste is, what fixing it is worth, and what fixing it costs —
so the next person starts from the numbers rather than from the hunch.

## Context

`chunkFeatureCache` is keyed on the chunk's virtual-offset span
(`chunkCacheKey`, `bamFile.ts`), and the chunk it is keyed on is the **merged**
chunk that `optimizeChunks` produced. That span depends on the query, so two
queries that need the same bytes can produce different keys and parse those
bytes twice.

This is visible from the consumer side too. `BamSlightlyLazyFeature` in
jbrowse-components already says so in passing — "different query ranges normally
produce different chunk keys, so the cache misses and each fetch decodes its own
copy. That is an accident of the key, not a guarantee" — but as a remark about
correctness, not as a cost anyone had measured.

## The mechanism

The raw bin chunks **abut**, chaining end-to-start with a zero gap, so the merge
in `optimizeChunks` swallows the whole run
(`chunkMinBlock - lastMaxBlock < 65000` is trivially satisfied at 0). Walking
`binIndex` directly on `200x.shortread.bam`, `chr22_mask`, 20 kb windows
stepping 5 kb:

```
win 0 [60000-80000]  lowest=4431968      win 1 [65000-85000]  lowest=4431968
   bin    585  4431968-4441574              bin    585  4431968-4441574
   bin   4684  4441574-5906987              bin   4684  4441574-5906987
   bin    585  5906987-5916715              bin    585  5906987-5916715
   bin   4685  5916715-7390512              bin   4685  5916715-7390512
   bin    585  7390512-7409322              bin    585  7390512-7409322
                                            bin   4686  7409322-8878026   <- new
   bin    585  8878026-8887617              bin    585  8878026-8887617
   => 4431968-7409322, 8878026-8887617      => 4431968-8887617
```

Two independent things move the merged endpoints while the underlying blocks
stay identical:

- **bin membership.** `reg2bins(min, max)` picks up bin 4686 at win 1, which
  bridges the break at 7409322 and extends the chain's end.
- **`getLowestChunk`.** As `min` rises, `lowest` moves from 4431968 to 5906987
  at win 2, pruning the chain's start.

So the merged spans slide across a pan, each one a fresh key:

```
4431968..7409322   2.98MB  52862 records
4431968..8887617   4.46MB  79337 records
5906987..8887617   2.98MB  53189 records
5906987..10377507  4.47MB  79481 records
7390512..10377507  2.99MB  53009 records
7390512..11852826  4.46MB  79259 records
8878026..11852826  2.97MB  52793 records
```

**The raw bin chunks are query-independent** — they come from `binIndex` and are
the same objects whatever the query. Only the merge is query-dependent. That is
the whole reason a fix is conceivable.

## What it costs today

Pans of `n` windows of `win` stepping `step`, comparing bytes actually
decompressed against the union of the compressed spans touched. `contained` is
the number of parsed spans that strictly contain another parsed span:

| file            | 20k/5k/12         | 5k/2.5k/16       | 100k/25k/10       |
| --------------- | ----------------- | ---------------- | ----------------- |
| 200x.shortread  | **68%** (19.4 MB) | **56%** (7.5 MB) | **72%** (46.2 MB) |
| volvox-sorted   | **71%** (0.9 MB)  | **58%** (0.5 MB) | **42%** (0.3 MB)  |
| ecoli_nanopore  | **66%** (2.3 MB)  | **65%** (2.2 MB) | **47%** (1.0 MB)  |
| shortreads_300x | **38%** (3.2 MB)  | 3%               | 1%                |
| 1000x.shortread | 0%                | 0%               | 2%                |
| chr22_nanopore  | 0%                | 0%               | 0%                |
| 200x.longread   | 0%                | 0%               | 12% (7.2 MB)      |
| 1000x.longread  | 0%                | 0%               | 7% (19.5 MB)      |
| cho             | 0%                | 0%               | 0%                |

Waste appears **iff** `contained > 0`, in every row. The waste is containment —
one parse fully redoing another — not partial overlap.

The affected profile is **shallow-to-moderate short-read data whose bin chunks
form abutting chains**. Deep long-read data is untouched at ordinary zoom. Worth
noting that volvox is the demo file, so the 71% is in front of everyone who
tries jbrowse for the first time, on 0.9 MB.

## What fixing it would be worth

Both keying strategies computed off the same index walk, no code changed:

| file            | geom     | merged key | raw key  | saved   | entries      |
| --------------- | -------- | ---------- | -------- | ------- | ------------ |
| 200x.shortread  | 20k/5k   | 28.4 MB    | 9.0 MB   | **68%** | 17 → 19      |
| 200x.shortread  | 100k/25k | 64.4 MB    | 18.2 MB  | **72%** | 24 → 26      |
| volvox          | 20k/5k   | 1.3 MB     | 0.4 MB   | **71%** | 7 → 7        |
| ecoli_nanopore  | 20k/5k   | 3.5 MB     | 1.2 MB   | **66%** | 5 → 16       |
| shortreads_300x | 20k/5k   | 8.3 MB     | 5.1 MB   | **38%** | 4 → 4        |
| 1000x.shortread | 20k/5k   | 41.8 MB    | 41.8 MB  | 0%      | 20 → 23      |
| 200x.longread   | 20k/5k   | 54.9 MB    | 54.9 MB  | 0%      | 6 → **41**   |
| 1000x.longread  | 100k/25k | 288.0 MB   | 268.4 MB | 7%      | 60 → **179** |

Keying on raw chunks recovers exactly the measured waste and never costs bytes.
The last column is the catch.

## Why it is parked

**It is not a one-repo change.** Merging has to stay for I/O — ADR 0011 measured
that dropping it takes a bare consumer from 6 reads to 95-378 _and_ downloads
more, because every small chunk pays its own tail padding. So the fetch unit
must stay merged while the cache unit becomes raw, which means **one fetch
populating N cache entries**. `SharedReadCache.get()` fills one key per call, so
this needs a batch-fill path in `@gmod/shared-read-cache` as well.

**The entry-count explosion is a real cost and it lands on the wrong files.** 6
→ 41 and 14 → 179 entries on the long-read fixtures, which gain nothing. More
LRU churn and per-entry overhead precisely where there is no benefit. Any real
attempt should expect to make this conditional rather than universal.

**It lands on four ADRs at once.** ADR 0006 (records are shared across queries —
they would be shared at a different granularity), ADR 0010 (the early stop reads
`featureLists[ci][0]`; finer chunks change when it fires, and its measured "the
stop always fired inside the first batch" result would have to be
re-established), ADR 0011 (merging), and ADR 0014/0016 (cache sizing, now with
up to 10x the entries under the same byte budget).

## The variant that looks obvious and is wrong

Serving a subset chunk out of a cached **superset** entry — a containment-aware
lookup instead of an exact key match — needs no re-keying and looks like a small
change. It is incorrect.

`makeDisjoint` guarantees that the chunks _of one query_ do not overlap, and the
docstring on it explains what happens when that fails: every record in an
overlap is returned twice, "rendered twice, counted twice in coverage, and
colliding on any id derived from fileOffset". A cached superset is not one of
the current query's chunks and can freely overlap the others, so serving from it
reintroduces exactly that. It would need dedup by `fileOffset` across the whole
result — a Set over every returned record, on queries that return 500k of them.

It also blunts the early stop: a superset's first record is earlier than the
subset's, so `isPastQuery` fires less often and the query reads more chunks.

Duplicated reads are a silent failure — they render, they just render twice — so
this is worth stating explicitly rather than rediscovering.

## A key that does not slide

The raw key above fixes the waste and pays for it twice: the entry count
explodes, and one fetch has to fill N entries. Both are consequences of choosing
the _finest_ query-independent unit. There is a coarser one.

**Canonical.** Merge the refId's whole chunk list once, by the same gap and span
rules, into a partition of the file. No query can reshape it: `reg2bins` and
`getLowestChunk` both _select_ from a partition rather than produce one. A query
computes its merged chunks as today, then reads the canonical chunks they land
in. `benchmarks/canonicalKeySim.ts` sizes it off the index alone.

Geometry is **10 windows of 19kb stepping 9.5kb**, not the 20k/5k of the table
above, so the `merged` and `raw` columns here are not the same numbers as that
one — read the three columns against each other, not across sections.

| file            | merged (ships) |          raw |       canonical |
| --------------- | -------------: | -----------: | --------------: |
| 20x.shortread   |   3.36 MB / 13 |    2.17 / 16 |    **2.50 / 1** |
| 200x.shortread  |  23.39 MB / 13 |   11.14 / 16 |   **13.94 / 3** |
| 1000x.shortread |  49.64 MB / 18 |   49.42 / 17 |      64.80 / 18 |
| 200x.longread   |  63.08 MB / 16 |   57.26 / 41 |   **55.31 / 6** |
| 1000x.longread  | 291.74 MB / 60 | 278.97 / 179 | **269.27 / 14** |

**Both objections go away.** Entries are 6 and 14 where the raw key gives 41 and
179 — _fewer than shipping today_, because merging over a whole contig is
coarser than merging one query's slice of it. So the entry-count cost above is
specific to the raw key, not to re-keying. And one fetch fills exactly one
entry, so there is no batch-fill path to build and this stops being a two-repo
change.

**It converges; the merged key does not.** Taking the pan from 10 windows to 30,
canonical does not move at all — 13.94 MB on 200x.shortread either way — while
merged grows 23.39 → 32.11 MB. That is the real statement of the bug: today
every window mints a fresh key, so panning inside bytes already held keeps
costing, and no cache size fixes it.

**The open question is the one regression.** 1000x.shortread fetches 64.80 MB
against 60.16 at convergence, ~8% worse, because a canonical chunk there is
bigger than the query's own and is pulled whole. **The span cap does not fix
it** — 0.25MB, 1MB and 5MB all land on ~64.8 MB, since the partition can never
be finer than the file's raw BAI chunks, which are already ~5MB at that depth.
That fixture is also the one with almost no redundancy to win (2.3% measured
from the consumer side), so it is paying over-fetch for a saving that is not
there. Which points at making this conditional on chunk shape — the same
conclusion item 1 below reaches from the other direction.

**A failed alternative, recorded so it is not re-proposed.** Snapping a query's
merged span outward to linear-index boundaries — a fixed grid rather than a
fixed partition — looked like it would give granularity as a tunable. It does
not work: at one interval the boundaries sit where the merged spans already
start and end, so it is indistinguishable from today; coarser grids over-fetch
catastrophically (25x on 1000x.shortread at 16 intervals).

## If someone picks this up

1. Decide whether the affected profile is worth it, or whether the fix should be
   conditional on chunk shape. Long-read data pays the raw key's entry count for
   nothing; deep short-read data pays canonical's over-fetch for nothing.
2. ~~Batch-fill in `@gmod/shared-read-cache`: one fetch, N entries.~~ Not needed
   for the canonical key — one fetch, one entry.
3. Re-run ADR 0010's early-stop measurements at whatever granularity is chosen.
   Canonical chunks are coarser than today's, so the stop fires later, and the
   "always inside the first batch" calibration has to be re-established.
4. Gate on the samtools agreement suite, **plus** a record-count-and-identity
   check across a pan. Duplicates are the failure mode here and they are silent;
   assert the number of DISTINCT `fileOffset`s, the way `makeDisjoint` was
   verified.

Reproductions used for every number above: a pan sweep over the fixtures, a raw
`binIndex` dump per window, and an offline simulation of the two keying
strategies. None of them modify the library — they walk the index and instrument
`_readChunkFeatures`.
