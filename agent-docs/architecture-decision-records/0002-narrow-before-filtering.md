# ADR 0002 — Narrow to the query range before applying `filterBy`

Status: Superseded by ADR 0005 (`filterBy` removed from bam-js entirely)

The reordering below was correct, and because of it the removal in ADR 0005 adds
no cost. A caller can filter only the records bam-js returns, and bam-js has
already narrowed those to the query range. This ADR stays as the record of why
in-library filtering was the wrong design.

## Context

`_fetchChunkFeatures` used to filter, then narrow:

```ts
const records = filterBy
  ? applyFilters(cached.features, filterBy)
  : cached.features
appendInRange(records, chrId, min, max, result)
```

Filtering and narrowing are independent predicates, so the result is the same in
either order, but their costs are far from symmetric:

- `appendInRange` relies on the coordinate sort and `break`s once it passes
  `max`, so it touches roughly the records up to the window plus the window
  itself.
- `applyFilters` has no such structure and touches **every** record in the
  chunk, decoding a tag on each one for `tagFilter`.

A cached chunk routinely holds tens of thousands of records while the query
covers a handful. Measured on `shortreads_300x.bam`, a warm 400 bp query
returning 69 records out of a ~27k-record chunk:

|               | cache-hit query |
| ------------- | --------------- |
| no filter     | 0.029 ms        |
| `flagExclude` | 1.77 ms         |
| `tagFilter`   | 3.79 ms         |

A filter therefore cost 60–130x the query it was filtering.

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
- Swapping the order was safe because both predicates are per-record and
  independent. Filtering also does not reorder records, so `appendInRange`'s
  early `break` on the coordinate sort still held.
- The unfiltered path did not change and still appends straight into `result`.
  After ADR 0005 it is the only path left.
