# ADR 0013 — The chunk cache stays on `evictionPolicy: 'lru'`

Status: Accepted (rejects the port). Sizing the budget is ADR 0014.

## Context

`@gmod/shared-read-cache` takes `evictionPolicy: 'lru' | 'batch'`. `'lru'`
evicts as each read settles. `'batch'` defers eviction until no reads are in
flight and then spares everything that batch touched. @gmod/cram is on `'batch'`
and measured 117ms against 12ms on a repeated 55,000-record range.

`_fetchChunkFeatures` follows the access pattern the package documents as the
case for `'batch'`. It starts up to `MAX_CONCURRENT_CHUNK_READS` (6) reads at
once and holds every chunk's records in `featureLists` until the query returns.
Evicting one chunk mid-query frees no memory, because the caller still holds it,
and it guarantees that the next identical query re-reads the chunk.

The access pattern matches, but it does not decide the choice.

## The deciding factor

`get()` re-inserts the entry at the MRU end (`SharedReadCache.js:88`), and
`maybeEvict` runs only when a read settles. A cold query therefore inserts its
own entries at the MRU end, and the cache evicts them last. Older queries go
first, which is what `'batch'` would have done. The policies diverge only when
**one query's working set exceeds `maxCacheBytes`**.

cram is 2.75x over that line, with `maxSize: 20000` records against a
55,000-record range. bam crosses the line too (see ADR 0014), so the choice
matters for bam, and we measured it.

## Measurement past the crossover

We measured `1000x.longread` with a 100kb window (533.5 MB working set) at the
then-default 100 MB budget. That working set is 5.3x over the line, the most
favourable case `'batch'` could ask for:

| policy  | warm pass | refills | held   |
| ------- | --------- | ------- | ------ |
| `lru`   | 5720ms    | 42      | 181 MB |
| `batch` | 6407ms    | 42      | 311 MB |

`'batch'` makes no improvement, since it has the same refill count as `lru` and
is marginally slower. It also retains 311 MB against a 100 MB budget where `lru`
retains 181 MB.

`'batch'` cannot retain a working set larger than the budget either. It spares
what the batch touched, ends the batch still over the limit and clears the
flags, and the next batch touches the same entries again. It therefore neither
keeps them across queries nor gets back under the ceiling. The delayed eviction
costs memory and does not raise the hit rate.

## Decision

Stay on `'lru'`. Do not port `'batch'`.

## Consequences / rationale

- **`maxCacheBytes` is the parameter to change, not the policy.** bam's budget
  is denominated in decompressed bytes, and its working set is measurable in the
  same unit, so a budget can be sized above it (ADR 0014). cram's budget is
  denominated in records, which cannot be converted to memory at all, so cram
  had no equivalent parameter and changing the policy was its only option. That
  difference in budget units, not the fan-out pattern, is why the port does not
  follow.

- **`'batch'` is second-chance, not unbounded.** It spares entries touched
  during the batch and then clears the flags. Eviction therefore runs one batch
  behind, and the next batch evicts any entry it does not touch again. The
  overshoot above is the trade-off the package documents: "a batch that touches
  more than the whole budget leaves the cache over it until the next batch
  lands".

## Correction — how the first draft of this ADR got it wrong

The version committed in `d251719` concluded that bam sat at 0.18–0.23x of the
crossover and that the policies were therefore indistinguishable. It made two
errors, both easy to repeat:

1. **It measured `test/data`.** ADR 0012 opens by warning that those files are
   correctness fixtures, and that sizing against them is how its own conclusions
   came out wrong the first time. The policy choice is a sizing question too,
   and the realistic corpus (`~/src/jb2bench/data`) puts bam at 0.72–5.3x, i.e.
   over the line.

2. **It read `totalSize` with the budget in place**, which reports what survived
   eviction rather than what the query needed. On the fixtures the two coincide,
   because the cache never evicts anything there, so the error did not show.
   Measure a working set with `maxCacheBytes: Infinity`. With the budget
   applied, the same query reports 180.7 MB where it needs 533.5 MB.

## Don't re-attempt without

A case where `'batch'` retains a working set `'lru'` drops **and** the hit rate
moves. The table above, a query 5.3x over budget, is the natural candidate.
There the two policies are within noise on time, and `'batch'` holds 1.7x the
memory.
