# ADR 0002 — Narrow to the query range before applying `filterBy`

Status: Superseded by ADR 0005 (`filterBy` removed from bam-js entirely)

The reordering below was correct and is why the removal in ADR 0005 costs
nothing: a caller can only filter the records it was handed, which are already
range-narrowed. Kept as the record of why in-library filtering was the wrong
shape.

## Context

`_fetchChunkFeatures` used to filter, then narrow:

```ts
const records = filterBy
  ? applyFilters(cached.features, filterBy)
  : cached.features
appendInRange(records, chrId, min, max, result)
```

The two are independent predicates, so the result is the same either way — but
the costs are not remotely symmetric:

- `appendInRange` relies on the coordinate sort and `break`s once it passes
  `max`, so it touches roughly the records up to the window plus the window
  itself.
- `applyFilters` has no such structure. It touches **every** record in the
  chunk, and for `tagFilter` decodes a tag on each one.

A cached chunk routinely holds tens of thousands of records while the query
covers a handful. Measured on `shortreads_300x.bam`, a warm 400 bp query
returning 69 records out of a ~27k-record chunk:

|               | cache-hit query |
| ------------- | --------------- |
| no filter     | 0.029 ms        |
| `flagExclude` | 1.77 ms         |
| `tagFilter`   | 3.79 ms         |

So a filter cost 60–130x the query it was filtering.

## Decision

Narrow first, filter the survivors. `applyFilters` gained an `out` parameter
(mirroring `appendInRange`) so the fused path allocates one intermediate array
rather than two:

```ts
if (filterBy) {
  applyFilters(appendInRange(features, chrId, min, max), filterBy, result)
} else {
  appendInRange(features, chrId, min, max, result)
}
```

## Consequences / rationale

- Same 400 bp query: `flagExclude` 1.77 → 0.046 ms, `tagFilter` 3.79 → 0.056 ms.
  A warm narrow+tagfilter loop is 9.3x (shortreads) / 33x (nanopore) faster end
  to end.
- Order was safe to swap: filtering does not reorder records, so
  `appendInRange`'s early `break` on the coordinate sort still held, and both
  predicates are per-record and independent.
- The unfiltered path was untouched and still appends straight into `result` —
  which is the only path left after ADR 0005.
