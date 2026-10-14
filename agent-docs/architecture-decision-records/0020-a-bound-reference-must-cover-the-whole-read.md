# ADR 0020 — A reference bound to a record must cover the whole read

Status: Accepted

## Context

`forEachMismatch` needs reference bases to report substitutions for a read with
no `MD` tag, which is most reads from most aligners. Those bases come from
outside the file, so the library needs a way to attach them to the record.

jbrowse-components took the obvious route, which is the bug
[ADR 0006](0006-cached-records-are-shared-and-must-not-be-mutated.md) describes:

```js
record.ref = regionSeq
record.refOffset = record.start - span.start
```

Records come out of a chunk cache and are shared between queries, so the last
fetch to resolve rebound the read for every other region still holding it, and a
read overlapping two regions had one region's mismatches resolved against the
other's sequence.

## Decision

`setReference(ref)` **throws unless `ref` covers `[record.start, record.end)`**,
and `getRecordsForRange` only binds regions that do.

A covering region is not per-query state, because every query that binds one
binds the same reference bases over the read's whole span. A rebinding by
another query therefore cannot change what this read reports. A partial region
resolves whatever part of the read it happens to cover, so the answer depends on
which query bound it last.

`getRecordsForRange` therefore fetches the **union span of the reads that need
the reference**, not the queried range, and binds only the reads the returned
bases cover.

A caller with any other reference, such as a partial region, a window, or a read
too long to fetch the span of, passes it to `forEachMismatch(cb, {ref})`. That
call retains nothing, so the covering rule does not apply to it.

## Consequences / rationale

- **A runtime check enforces the rule.** ADR 0006's residual is "nothing
  enforces this". Here the one method that writes to a shared record checks the
  rule at runtime, so a violation throws at the binding instead of producing
  wrong mismatches downstream with no error.

- **One field per record**, `_reference`, costs 8 bytes on every record whether
  or not anyone reports a mismatch, about +180KB on a 22k-record chunk. The
  field lets the common case be a bare `getMismatches()` call.

- **A read the fetched region misses reports no substitutions.** The walk is
  synchronous and cannot fetch more bases, so it reports none and raises no
  error. The caller can detect the case as `record.reference === undefined`.

- **The fetch span has no cap.** A whole chromosome stored as one BAM read makes
  the union a chromosome. The consumer decides in its callback what its sequence
  source can afford, and a callback that returns a shorter region degrades
  exactly like the case above, so the span policy belongs in the callback and
  not in a constant here. See also ADR 0021 on what the walk does with a window.

## Rejected alternatives

- **A per-query wrapper object** (what jbrowse-components does now, and what ADR
  0006 recommends). The wrapper is correct, and it stays available through
  `opts.ref`. As the primary API, though, it stops a consumer from calling
  `record.getMismatches()` and getting an answer. The consumer has to thread the
  reference from the query to every call site by hand, which is the plumbing the
  decision above removes.

- **A file-level cache of fetched regions the record looks itself up in.** The
  cache needs no per-record field and is correct on the same "a covering region
  is a covering region" grounds. We rejected it for being nondeterministic in a
  worse way than the rule above: whether a read resolves would depend on which
  regions the LRU still holds, so the same query could answer differently on a
  warm and a cold cache.

- **Bind partial regions, keeping whichever covers more.** This option makes the
  answer depend on query order again, though less often. A read would lose the
  mismatches outside the newest region, which looks like a rendering glitch
  rather than a bug.

## Known residual

`setReference` is public, so a consumer can bind a covering region to a record
and pin that region's bytes for as long as the chunk cache holds the record. A
region is one byte per base, against a chunk cache measured in hundreds of MB,
so this is not currently worth a mechanism.
