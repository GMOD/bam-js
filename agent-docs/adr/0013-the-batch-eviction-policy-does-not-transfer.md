# ADR 0013 — The chunk cache stays on `evictionPolicy: 'lru'`

Status: Accepted (rejects the port; records the crossover so the question does
not get reopened from cram's numbers)

## Context

`@gmod/shared-read-cache` takes `evictionPolicy: 'lru' | 'batch'`. `'lru'`
evicts as each read settles, so the budget is a hard ceiling. `'batch'` defers
eviction until no reads are in flight and then spares everything that batch
touched. @gmod/cram is on `'batch'` and measured 117ms against 12ms on a
repeated 55,000-record range.

`_fetchChunkFeatures` has the shape the package's own docs describe as the case
for `'batch'`: it starts up to `MAX_CONCURRENT_CHUNK_READS` (6) reads at once
and holds every chunk's records in `featureLists` until the query returns.
Evicting one of them mid-query frees nothing — the caller is still holding it —
but does guarantee the next identical query re-reads it.

So the shape matches. The shape is not what decides it.

## What actually decides it

`SharedReadCache.get()` moves the entry to the MRU end. Under `'lru'` a query's
own chunks are therefore the **last** things it will evict: it evicts older
queries first, which is exactly what `'batch'` would have done. The two policies
are indistinguishable unless **one query's working set exceeds
`maxCacheBytes`**, which is the only condition under which a query evicts its
own earlier chunks and so guarantees the repeat re-reads them.

cram is 2.75x over that line: `maxSize: 20000` records against a 55,000-record
range. bam is an order of magnitude under it. Decompressed working set after one
cold query, against the 100 MB default:

| fixture                     | chunks | records | working set | of budget |
| --------------------------- | -----: | ------: | ----------: | --------: |
| `shortreads_300x.bam`       |      2 |  53,596 |     17.7 MB |     0.18x |
| `chr22_nanopore_subset.bam` |      3 |     757 |     23.2 MB |     0.23x |

Both rows are the widest query those files support — a whole-chromosome query
returns the same set, because they are single-region subsets.

## Measured anyway

Repeated identical query, and a 5-window pan sweep, 5 reps each after a warm
pass. `refills` counts `_readChunkFeatures` calls after the warm pass, i.e. work
the cache should not have needed to redo:

| fixture   | mode   |     budget |            lru |     batch |
| --------- | ------ | ---------: | -------------: | --------: |
| shortread | repeat | **100 MB** |      26.8ms, 0 | 20.6ms, 0 |
| shortread | repeat |      32 MB |      15.0ms, 0 | 19.3ms, 0 |
| shortread | repeat |      16 MB | 136.0ms, **5** | 15.6ms, 0 |
| shortread | repeat |       8 MB | 123.1ms, **5** | 14.3ms, 0 |
| shortread | pan    | **100 MB** |      29.9ms, 0 | 26.9ms, 0 |
| shortread | pan    |      16 MB | 229.3ms,**10** | 28.5ms, 0 |
| nanopore  | repeat | **100 MB** |       0.6ms, 0 |  0.3ms, 0 |
| nanopore  | repeat |      32 MB |       0.4ms, 0 |  0.3ms, 0 |
| nanopore  | repeat |      16 MB | 283.3ms, **9** |  0.4ms, 0 |
| nanopore  | repeat |       8 MB | 322.3ms,**10** |  0.4ms, 0 |
| nanopore  | pan    | **100 MB** |       0.6ms, 0 |  0.6ms, 0 |
| nanopore  | pan    |      16 MB | 571.2ms,**16** |  0.7ms, 0 |
| nanopore  | pan    |       8 MB | 687.8ms,**20** |  0.6ms, 0 |

At the default the two policies are **identical** — zero refills either way, and
the time column is this box's noise floor. Below the working set cram's cliff
reproduces, and harder than cram's own 117→12.

Read the 8/16 MB rows as stress, not as configuration: `optimizeChunks` merges
spans up to 5 MB compressed, so an entry here is 7.7–8.9 MB (consistent with ADR
0001's "8MB apiece"). A 16 MB budget holds two entries and an 8 MB budget holds
_one_ — `evict()`'s keep-the-last-settled-entry rule is the only thing between
it and holding none. That is not a cache that is slightly too small.

## Decision

Stay on `'lru'`. Do not port `'batch'`.

## Consequences / rationale

- **The lever, if this ever bites, is `maxCacheBytes` — not the policy.** bam's
  budget is denominated in decompressed bytes and its working set is directly
  measurable in the same unit, so a consumer that needs a wider query to stay
  warm can size the budget above it and keep the ceiling. cram's budget is
  denominated in records, which cannot be converted to memory at all, so it had
  no equivalent lever and changing policy was the only move available. That
  asymmetry — not the fan-out shape — is why the port does not follow.

- **`'batch'` is not unbounded; it is second-chance.** It spares entries touched
  during the batch, then clears the flags, so the next batch evicts them if they
  were not re-touched. It runs one batch behind, not forever.

- **But `pending === 0` is a condition on the whole cache, not on one request.**
  bam's caller runs many queries concurrently against one `BamFile` — several
  blocks, several tracks — so under sustained overlapping load `evict()` need
  never run. Measured on `shortreads_300x`, 8 windows, 8 MB budget:

  | queries    |                       lru |                          batch |
  | ---------- | ------------------------: | -----------------------------: |
  | sequential | peak 10.3 MB, settled 0.1 | peak 17.8 MB, settled **17.8** |
  | concurrent |  peak 0.1 MB, settled 0.1 | peak 17.8 MB, settled **17.8** |

  `'batch'` settles 2.2x over its limit and stays there. On a subset fixture the
  overshoot is capped by the file; on a real one it is however much the session
  touched. This is the sharper reason to decline, and it is not in the package
  docs — those only say "do not use it where the budget is a memory guarantee".

## Methodology / limits

- `LocalFile`, so a refill costs decompress only. Over HTTP it also costs a
  round trip, which steepens the cliff but does not move the crossover — the
  crossover is set by working set vs budget, which is transport-independent.
- Both fixtures are single-region subsets, so their whole-chromosome query is
  their narrow query. A whole-chromosome query on a full-size BAM could clear
  100 MB — but that is not a query jbrowse issues at read-rendering zoom, and
  ADR 0010's early stop cuts it further.
- The A/B swapped `bam.chunkFeatureCache` for a cache constructed with the same
  `sizeOf`/`cacheKey`/`fill` and the other policy. Nothing in `src/` changed.

## Don't re-attempt without

A profile showing a **single query's** decompressed working set above
`maxCacheBytes` on data a consumer actually queries. Absent that, the policies
are the same code path and the measurement will show noise. If you do find one,
raise the budget first and confirm the policy still matters afterwards.
