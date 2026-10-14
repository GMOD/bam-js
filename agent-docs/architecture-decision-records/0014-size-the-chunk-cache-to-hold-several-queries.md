# ADR 0014 — Size the chunk cache to hold several queries, not one

Status: Accepted (raises `DEFAULT_MAX_CACHE_BYTES` from 100 MB to 512 MB)

## Context

The parsed-chunk cache is bounded by decompressed bytes, defaulting to 100 MB.
The number predates any measurement of what a query needs.

A byte budget on this cache does not degrade gracefully. Below one query's
working set, the cache evicts each chunk before the next pan can reuse it, so
the hit rate is zero and every pan re-downloads and re-decompresses its chunks.
In-flight and last-settled entries are unevictable, so the cache retains the
memory anyway and saves no work. We measured a six-window pan over the jb2bench
corpus:

| corpus            | 100 MB         | 200 MB      | 400 MB       | 800 MB     |
| ----------------- | -------------- | ----------- | ------------ | ---------- |
| `200x.shortread`  | 591ms, 7/14    | **69ms, 0** | 64ms, 0      | 67ms, 0    |
| `200x.longread`   | 932ms, 9/14    | **1ms, 0**  | 1ms, 0       | 1ms, 0     |
| `1000x.shortread` | 3137ms, 59/59  | 2037ms, 21  | **345ms, 0** | 365ms, 0   |
| `1000x.longread`  | 16343ms, 98/98 | 13549ms, 96 | 8548ms, 51   | **1ms, 0** |

59/59 and 98/98 are total misses, so at 100 MB the cache returns nothing it was
asked for on those two corpora.

## What sets the scale — the consumer's byte gate, not how deep data can get

Sizing this against the deepest data available would be sizing against queries
nobody issues, because jbrowse gates BAM queries before making them.
`BamAdapter.getRegionByteSize` calls `estimatedBytesForRegions`, and jbrowse
compares the result against the adapter's `fetchSizeLimit`. Over the limit, the
user gets "region too large" rather than a query.

The gate counts **compressed** bytes from the index, and this cache budgets
**decompressed** bytes. The BGZF ratio converts one to the other, and we
measured it across the corpus at **2.1–7.3x** (median 2.1 long-read, 3.7–6.5
short-read):

| `fetchSizeLimit`                           | max query, decompressed | six-window pan |
| ------------------------------------------ | ----------------------- | -------------- |
| 5 MB — jbrowse default                     | 10–37 MB                | ~219 MB        |
| 30 MB — jbrowse's own SV demo, PacBio HiFi | 63–219 MB               | ~378 MB        |

The 30 MB row is a shipped config (`website/scripts/specs/sv.ts`), not a stress
case, and at a 100 MB budget a **single** query there exceeds the whole cache.
Direct bam-js consumers have no gate at all.

## Decision

`DEFAULT_MAX_CACHE_BYTES = 512 * 1024 * 1024`.

512 MB clears a six-window pan at both the stock gate and the raised one, with
`1000x.shortread` reaching zero refills as a side effect.

## Consequences / rationale

- **Consumers on ordinary data pay nothing for the raise.** The budget is a
  ceiling, not an allocation. At any setting, `20x.shortread` holds 7 MB,
  `200x.longread` 124 MB, `200x.shortread` 156 MB. The budget binds only where
  the old default was returning a 0% hit rate.

- **Don't pick a number between one query and several.** That is the region
  where the cache costs memory and returns nothing. Either size above the
  working set, or pass `Infinity` and bound memory another way.

- **The budget is a retention bound, not a peak-memory bound**, and the docs now
  say so. Three things sit outside it: a read in flight is never evicted and six
  run at once; the cache keeps the last settled entry whatever the budget; and a
  query holds every chunk it parsed until it returns, regardless of the cache.
  On `1000x.longread` one chunk is 180.7 MB, and six in flight is 476 MB. The
  old 100 MB default already peaked at 181 MB, so it was never the guarantee the
  docs described.

- **The default is finite on purpose.** Unbounded would be faster still and is
  what the package defaults to, but jbrowse memoizes one `BamFile` per adapter
  for the life of the track (`BamAdapter.ts:23-49`) and passes no budget. The
  default alone therefore keeps a long panning session from growing memory
  without bound, as in the `@gmod/tabix` 2 GB case the package docs cite.

## Rejected: make the entries smaller instead

The obvious alternative is to keep a small budget and reduce entry size, so the
LRU has something to order, but the chunk size rules this out.

A single entry on `1000x.longread` is 180.7 MB decompressed. At the measured
ratios that is ~86 MB compressed, 17x `optimizeChunks`' 5 MB merge cap, so the
entry is not a merge product. The BAI lists it as one chunk of that size, and
lowering the merge cap cannot shrink it. Splitting the chunk would mean
sub-dividing it at BGZF block boundaries with records straddling them, which is
the reason ADR 0001 gives for the cache unit being the chunk in the first place.

## Methodology

We measured working sets with `maxCacheBytes: Infinity`. With a budget applied,
`totalSize` reports what survived eviction, not what the query needed, and
understates it 3x on the case above (see ADR 0013's correction note). The pan is
six windows of 50kb stepping 25kb and doubling back, timed on the second pass.
The runs use `LocalFile`, so a refill costs only decompression; over HTTP each
refill also costs a round trip, which widens every gap in the table.
