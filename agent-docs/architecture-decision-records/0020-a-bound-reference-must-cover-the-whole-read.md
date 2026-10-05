# ADR 0020 — A reference bound to a record must cover the whole read

Status: Accepted

## Context

`forEachMismatch` needs reference bases to report substitutions for a read with
no `MD` tag, which is most reads from most aligners. Those bases arrive from
outside the file, so something has to get them onto the record.

The obvious way is what jbrowse-components did, and it is the bug
[ADR 0006](0006-cached-records-are-shared-and-must-not-be-mutated.md) is about:

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

The point is that a covering region is not per-query state at all. Any query
that binds one binds bases that say the same thing about this read, because they
are the same reference over the read's whole span — so a rebinding by another
query cannot change what this read reports. A partial region is the opposite: it
resolves whatever part of the read it happens to cover, so which query bound it
last is visible in the answer.

`getRecordsForRange` therefore fetches the **union span of the reads that need
the reference**, not the queried range, and binds only the reads the returned
bases cover.

Anything else that wants a reference — a partial region, a window, a read too
long to fetch the span of — goes through `forEachMismatch(cb, {ref})`, which
retains nothing and so has no such rule.

## Consequences / rationale

- **Nothing to get wrong.** ADR 0006's residual is "nothing enforces this". Here
  the rule is a runtime check on the one method that writes to a shared record,
  so the failure mode is a loud throw at the binding rather than quiet wrong
  mismatches somewhere downstream.

- **One field per record**, `_reference`, i.e. 8 bytes on every record whether
  or not anyone reports a mismatch — about +180KB on a 22k-record chunk. Paid so
  that the common case is `getMismatches()` with no ceremony.

- **A read the fetched region misses reports no substitutions.** Silent, and it
  has to be: the walk is synchronous and cannot go and get more bases. It is
  visible as `record.reference === undefined`.

- **No cap on the fetch span.** A whole chromosome stored as one BAM read makes
  the union a chromosome. Only the consumer's callback knows what its sequence
  source can afford, and a callback that returns a shorter region degrades
  exactly like the case above — so the policy lives there rather than in a
  constant here. See also ADR 0021 on what the walk does with a window.

## Rejected alternatives

- **A per-query wrapper object** (what jbrowse-components does now, and what ADR
  0006 recommends). Correct, and it stays available through `opts.ref`, but as
  the primary API it means a consumer cannot call `record.getMismatches()` and
  get an answer — the reference has to be threaded from the query to every call
  site by hand, which is the plumbing this option exists to remove.

- **A file-level cache of fetched regions the record looks itself up in.** No
  per-record field, and correct on the same "a covering region is a covering
  region" grounds. Rejected for being nondeterministic in a worse way than the
  rule above: whether a read resolves would depend on which regions the LRU
  still holds, so the same query could answer differently on a warm and a cold
  cache.

- **Bind partial regions, keeping whichever covers more.** Makes the answer
  depend on query order again, just less often — the failure would be a read
  losing the mismatches outside the newest region, which looks like a rendering
  glitch rather than a bug.

## Known residual

`setReference` is public, so a consumer can bind a covering region to a record
and pin that region's bytes for as long as the chunk cache holds the record. A
region is one byte per base, against a chunk cache measured in hundreds of MB,
so this is not currently worth a mechanism.
