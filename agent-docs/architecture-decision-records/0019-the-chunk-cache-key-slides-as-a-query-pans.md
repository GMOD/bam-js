# ADR 0019 — The chunk cache key slides as a query pans

Status: **Parked, but the two costs that parked it now have an answer.** A
canonical partition (see "A key that does not slide" below) has fewer cache
entries than the merged key that ships today and fills one entry per fetch, so
`@gmod/shared-read-cache` needs no change and the fix stays in this repo. Nobody
has built the canonical key, and one measured regression is the open question.

This ADR records what the waste is, what fixing it is worth and what fixing it
costs, so the next person starts from the numbers.

## Context

`chunkFeatureCache` is keyed on the chunk's virtual-offset span
(`chunkCacheKey`, `bamFile.ts`), and the chunk it is keyed on is the **merged**
chunk that `optimizeChunks` produced. That span depends on the query, so two
queries that need the same bytes can produce different keys and parse those
bytes twice.

jbrowse-components mentions the sliding key in passing, in the source of
`BamSlightlyLazyFeature`: "different query ranges normally produce different
chunk keys, so the cache misses and each fetch decodes its own copy. That is an
accident of the key, not a guarantee". The remark concerns correctness, and
nobody had measured the cost.

## The mechanism

The raw bin chunks **abut**, chaining end-to-start with a zero gap, so the merge
in `optimizeChunks` joins the whole run into one chunk
(`chunkMinBlock - lastMaxBlock < 65000` is trivially satisfied at 0). A walk of
`binIndex` on `200x.shortread.bam`, `chr22_mask`, with 20 kb windows stepping 5
kb, gives:

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

The merged spans therefore slide across a pan, and each span is a fresh key:

```
4431968..7409322   2.98MB  52862 records
4431968..8887617   4.46MB  79337 records
5906987..8887617   2.98MB  53189 records
5906987..10377507  4.47MB  79481 records
7390512..10377507  2.99MB  53009 records
7390512..11852826  4.46MB  79259 records
8878026..11852826  2.97MB  52793 records
```

**The raw bin chunks are query-independent.** They come from `binIndex` and are
the same objects whatever the query. Only the merge depends on the query, so a
fix is conceivable.

## What it costs today

Each column pans `n` windows of `win` stepping `step`, and each cell compares
the bytes decompressed against the union of the compressed spans the pan
touched. `contained` is the number of parsed spans that strictly contain another
parsed span:

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

In every row, waste appears **iff** `contained > 0`. The waste comes from
containment, where one parse fully redoes another, and not from partial overlap.

The affected profile is **shallow-to-moderate short-read data whose bin chunks
form abutting chains**. Deep long-read data is untouched at ordinary zoom.
Volvox is the demo file, so the 71% waste applies to everyone who tries jbrowse
for the first time, on 0.9 MB.

## Keying on raw chunks recovers all the waste but adds entries

We computed the merged and raw keys from the same index walk, without changing
any code:

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

Keying on raw chunks recovers exactly the measured waste and never costs bytes,
but it raises the number of cache entries, as the last column shows.

## Why it is parked

**The raw key is not a one-repo change.** Merging has to stay for I/O, because
ADR 0011 measured that dropping it takes a bare consumer from 6 reads to 95-378
_and_ downloads more, because each small chunk adds its own tail padding to the
download. The fetch unit must therefore stay merged while the cache unit becomes
raw, so **one fetch has to fill N cache entries**. `SharedReadCache.get()` fills
one key per call, so the change also needs a batch-fill path in
`@gmod/shared-read-cache`.

**The raw key multiplies the entry count on the files that gain least.** The
long-read fixtures, which save 7-12%, go from 6 → 41 and 60 → 179 entries, so
they pay more LRU churn and per-entry overhead for a small saving. An attempt
should expect to make the raw key conditional rather than universal.

**Re-keying affects four ADRs.** ADR 0006 (records are shared across queries,
and would be shared at a different granularity), ADR 0010 (the early stop reads
`featureLists[ci][0]`; finer chunks change when it fires, and its measured "the
stop always fired inside the first batch" result would have to be
re-established), ADR 0011 (merging), and ADR 0014/0016 (cache sizing, now with
up to about 7x the entries under the same byte budget).

## Serving a subset from a cached superset is wrong

A containment-aware lookup, which serves a subset chunk out of a cached
**superset** entry instead of requiring an exact key match, needs no re-keying
and looks like a small change, but it is incorrect.

`makeDisjoint` guarantees that the chunks _of one query_ do not overlap. Its
docstring explains that when they do overlap, the query returns every record in
the overlap twice, "rendered twice, counted twice in coverage, and colliding on
any id derived from fileOffset". A cached superset is not one of the current
query's chunks and can overlap the others, so serving from it reintroduces
exactly those duplicates. Removing them would need dedup by `fileOffset` across
the whole result, a Set over every returned record, on queries that return 500k
of them.

A superset lookup also weakens the early stop. A superset's first record is
earlier than the subset's, so `isPastQuery` fires less often and the query reads
more chunks.

Duplicated reads raise no error, and the display draws each one twice. This
section records the failure so that nobody has to rediscover it.

## A key that does not slide

The raw key above fixes the waste at two costs: the entry count explodes, and
one fetch has to fill N entries. Both are consequences of choosing the _finest_
query-independent unit, and a coarser one exists.

**Canonical.** Merge the refId's whole chunk list once, by the same gap and span
rules, into a partition of the file. A query cannot change the partition,
because `reg2bins` and `getLowestChunk` only _select_ chunks from it. A query
computes its merged chunks as today, then reads the canonical chunks that
overlap them. `benchmarks/canonicalKeySim.ts` sizes the partition from the index
alone.

The pan here is **10 windows of 19kb stepping 9.5kb**, not the 20k/5k of the
earlier table, so the `merged` and `raw` columns differ from that table's.
Compare the three columns with each other, not with the earlier section.

| file            | merged (ships) |          raw |       canonical |
| --------------- | -------------: | -----------: | --------------: |
| 20x.shortread   |   3.36 MB / 13 |    2.17 / 16 |    **2.50 / 1** |
| 200x.shortread  |  23.39 MB / 13 |   11.14 / 16 |   **13.94 / 3** |
| 1000x.shortread |  49.64 MB / 18 |   49.42 / 17 |      64.80 / 18 |
| 200x.longread   |  63.08 MB / 16 |   57.26 / 41 |   **55.31 / 6** |
| 1000x.longread  | 291.74 MB / 60 | 278.97 / 179 | **269.27 / 14** |

**Both objections go away.** On the long-read files the canonical key has 6 and
14 entries where the raw key has 41 and 179, _fewer than the merged key that
ships today_, because merging over a whole contig gives coarser chunks than
merging one query's slice of it. The entry-count cost above is therefore
specific to the raw key, not to re-keying. One fetch also fills exactly one
entry, so there is no batch-fill path to build and the change stays in this
repo.

**The canonical key converges, and the merged key does not.** When the pan grows
from 10 windows to 30, canonical stays at 13.94 MB on 200x.shortread, while
merged grows 23.39 → 32.11 MB. Today every window creates a fresh key, so a pan
over bytes the cache already holds keeps costing bytes, and no cache size fixes
that.

**The open question is the one regression.** 1000x.shortread fetches 64.80 MB
against 60.16 at convergence, ~8% worse, because a canonical chunk there is
bigger than the query's own and the reader fetches it whole. **The span cap does
not fix it.** Caps of 0.25MB, 1MB and 5MB all give ~64.8 MB, since the partition
can never be finer than the file's raw BAI chunks, which are already ~5MB at
that depth. That fixture also has almost no redundancy to remove (2.3% measured
from the consumer side), so it is paying over-fetch for a saving that is not
there. The regression points at making the canonical key conditional on chunk
shape, the same conclusion item 1 below reaches from the other direction.

**A failed alternative, recorded so it is not re-proposed.** Snapping a query's
merged span outward to linear-index boundaries, a fixed grid instead of a fixed
partition, looked like it would make the granularity a parameter. At one
interval the boundaries sit where the merged spans already start and end, so the
result is indistinguishable from today's. Coarser grids over-fetch
catastrophically (25x on 1000x.shortread at 16 intervals).

## If someone picks this up

1. Decide whether the affected profile is worth it, or whether the fix should be
   conditional on chunk shape. Long-read data pays the raw key's entry count for
   nothing; deep short-read data pays canonical's over-fetch for nothing.
2. ~~Batch-fill in `@gmod/shared-read-cache`: one fetch, N entries.~~ The
   canonical key does not need it, because one fetch fills one entry.
3. Re-run ADR 0010's early-stop measurements at whatever granularity is chosen.
   Canonical chunks are coarser than today's, so the stop fires later, and the
   "always inside the first batch" calibration has to be re-established.
4. Gate on the samtools agreement suite, **plus** a record-count-and-identity
   check across a pan. Duplicates are the failure mode here and raise no error,
   so assert the number of distinct `fileOffset`s, the way `makeDisjoint` was
   verified.

Every number above comes from three reproductions: a pan sweep over the
fixtures, a raw `binIndex` dump per window, and an offline simulation of the two
keying strategies. They walk the index and instrument `_readChunkFeatures`
without modifying the library.
