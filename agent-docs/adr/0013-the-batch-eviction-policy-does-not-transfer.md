# ADR 0013 — The chunk cache stays on `evictionPolicy: 'lru'`

Status: Accepted (rejects the port). Sizing the budget is ADR 0014.

## Context

`@gmod/shared-read-cache` takes `evictionPolicy: 'lru' | 'batch'`. `'lru'`
evicts as each read settles. `'batch'` defers eviction until no reads are in
flight and then spares everything that batch touched. @gmod/cram is on `'batch'`
and measured 117ms against 12ms on a repeated 55,000-record range.

`_fetchChunkFeatures` has the shape the package documents as the case for
`'batch'`: it starts up to `MAX_CONCURRENT_CHUNK_READS` (6) reads at once and
holds every chunk's records in `featureLists` until the query returns. Evicting
one mid-query frees nothing — the caller is still holding it — but does
guarantee the next identical query re-reads it.

The shape matches. It is not what decides it.

## What decides it

`get()` re-inserts the entry at the MRU end (`SharedReadCache.js:88`), and
`maybeEvict` only runs when a read settles. A cold query's own entries are
therefore inserted at the MRU end and evicted last: it evicts older queries
first, which is what `'batch'` would have done. The policies diverge only when
**one query's working set exceeds `maxCacheBytes`**.

cram is 2.75x over that line: `maxSize: 20000` records against a 55,000-record
range. bam crosses it too — see ADR 0014 — so the question is live, and had to
be measured rather than argued.

## Measured where the crossover is actually crossed

`1000x.longread`, 100kb window (533.5 MB working set), at the then-default 100
MB budget — 5.3x over the line, the most favourable case `'batch'` could ask
for:

| policy  | warm pass | refills | held   |
| ------- | --------- | ------- | ------ |
| `lru`   | 5720ms    | 42      | 181 MB |
| `batch` | 6407ms    | 42      | 311 MB |

`'batch'` does not rescue it. Identical refill count, marginally slower, and it
retains 311 MB against a 100 MB budget where `lru` retains 181 MB.

The reason is that `'batch'` cannot retain a working set larger than the budget
either. It spares what the batch touched, ends the batch still over the limit,
clears the flags, and the next batch re-touches the same entries — so it neither
keeps them across queries nor gets back under the ceiling. It buys the eviction
delay and pays for it in memory, with no hit-rate return.

## Decision

Stay on `'lru'`. Do not port `'batch'`.

## Consequences / rationale

- **The lever is `maxCacheBytes`, not the policy.** bam's budget is denominated
  in decompressed bytes and its working set is measurable in the same unit, so a
  budget can be sized above it (ADR 0014). cram's budget is denominated in
  records, which cannot be converted to memory at all, so it had no equivalent
  lever and changing policy was the only move available. That asymmetry, not the
  fan-out shape, is why the port does not follow.

- **`'batch'` is second-chance, not unbounded.** It spares entries touched
  during the batch, then clears the flags, so the next batch evicts them if they
  were not re-touched. It runs one batch behind. The overshoot above is the
  documented trade — "a batch that touches more than the whole budget leaves the
  cache over it until the next batch lands" — not a new finding.

## Correction — how the first draft of this ADR got it wrong

The version committed in `d251719` concluded that bam sat at 0.18–0.23x of the
crossover and that the policies were therefore indistinguishable. Two errors,
and both are easy to repeat:

1. **It measured `test/data`.** ADR 0012 opens by warning that those are
   correctness fixtures and that sizing against them is how its own conclusions
   came out wrong the first time. This is a sizing question. The realistic
   corpus (`~/src/jb2bench/data`) puts bam at 0.72–5.3x, i.e. over the line.

2. **It read `totalSize` with the budget in place**, which reports what survived
   eviction rather than what the query needed. On the fixtures the two coincide,
   because nothing there is ever evicted — which is exactly why the error was
   invisible. Measure a working set with `maxCacheBytes: Infinity`. With the
   budget applied, the same query reports 180.7 MB where it actually needs 533.5
   MB.

## Don't re-attempt without

A case where `'batch'` retains a working set `'lru'` drops **and** the hit rate
moves. The table above is the natural candidate — a query 5.3x over budget — and
there the two are within noise on time and `'batch'` is 1.7x worse on memory.
