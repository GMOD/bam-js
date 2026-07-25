# ADR 0005 — `filterBy` belongs in the caller, not in bam-js

Status: Accepted

## Context

`BamOpts.filterBy` (`flagInclude` / `flagExclude` / one `tagFilter`) is a
predicate over already-parsed records. It saves no I/O and no decompression — by
the time it runs, the expensive work is done. The question is whether bam-js
should own it at all.

Checking what `jbrowse-components` — the primary consumer, and the origin of
every `flagInclude`/`flagExclude` reference outside this repo — actually does:

**bam-js's `tagFilter` is already dead code there.** JBrowse's `FilterBy`
(`plugins/alignments/src/shared/types.ts`) is:

```ts
export interface FilterBy {
  flagExclude: number
  flagInclude: number
  readName?: string
  tagFilters?: TagFilter[] // plural
}
```

There is no singular `tagFilter`, and `normalizeFilterBy` exists specifically to
fold the legacy singular form into the plural one "so every consumer only ever
reads the plural form". It is applied at the model layer
(`LinearAlignmentsDisplay/model.ts`'s `filterBy` getter), and nothing in the
plugin sets the singular key. So JBrowse hands `getRecordsForRange` an object
whose `tagFilter` is always `undefined`: bam-js applies the two flag masks and
silently skips a third of its own filter API.

Three more findings point the same way:

- **The filtering is already split across two layers.** `BamAdapter.getFeatures`
  passes `filterBy` down, then runs its own loop applying `readName` and the
  plural `tagFilters`. Its comment spells out the seam: _"@gmod/bam applies only
  flags + a single tagFilter; multiple tag filters are AND-ed here."_ One tag
  filter would be applied in a different place from the other N — except it
  isn't applied at all.
- **JBrowse already carries its own copies** of `filterReadFlag` and
  `filterTagValue` in `shared/util.ts`, duplicating bam-js's.
- **CRAM already does it the right way.** `CramAdapter.shouldFilterRecord`
  handles flags, `tagFilters`, `readName`, _and_ RG resolution through the SAM
  header, entirely in the adapter. cram-js has no `filterBy`. BAM is the
  inconsistent one.

## Decision

Move all filtering to the caller and drop `filterBy` from bam-js: `FilterBy`,
`TagFilter`, `applyFilters`, `readTag`, `Filterable`, `filterReadFlag`,
`filterTagValue`, and `BamOpts.filterBy`.

## Consequences / rationale

- **Costs nothing in performance.** `BamAdapter.getFeatures` already iterates
  every returned record unconditionally — it sets `record.adapter`, resolves the
  reference for reads lacking MD, and emits to the observer. Folding the flag
  masks into that existing loop adds zero iterations. And `getTag` is public, so
  the caller keeps the cheap single-tag decode that `readTag` was there to
  provide (JBrowse already calls `record.getTag(tf.tag)` in that loop).

- **Removes a bug class.** ADR 0002 exists only because filtering was
  library-internal and therefore easy to apply at the wrong point — over a whole
  cached chunk instead of the query's records. A caller can only filter what it
  was handed, which is already range-narrowed, so the mistake is unavailable.

- **Simplifies the cache contract.** `chunkCacheKey`'s "keyed on the byte span
  only, not on filterBy" caveat goes away with the option.

- **Does not help memory**, which is worth stating because it is the tempting
  reason to keep filtering inside the library. Records are _views_: every
  `BamRecord` holds `_byteArray`, the chunk's whole decompressed buffer, so one
  survivor pins all of it. Measured on a `shortreads_300x.bam` chunk (7.8 MB
  decompressed, 22 443 records):

  | retained           | V8 heap | pinned buffer |
  | ------------------ | ------- | ------------- |
  | all 22 443 records | 2.71 MB | 7.8 MB        |
  | 10% of records     | 0.29 MB | 7.8 MB        |
  | 0 records          | 0.01 MB | 7.8 MB        |

  Filtering can only reclaim ~120 B wrapper objects, never the payload — 2.4 MB
  of 10.5 MB even at 90% rejection, and under 1% on long reads (757 nanopore
  records over a 24.4 MB buffer), i.e. nothing on exactly the files where memory
  hurts. Shrinking what a chunk pins would mean copying survivors out of the
  shared buffer, trading away the zero-copy design; that would need its own ADR.

- **`viewAsPairs` loses one composition.** `fetchPairs` receives the post-filter
  result today, so mate lookups are issued only for surviving reads; a caller
  filtering the returned array would fetch mates for reads it then discards.
  Real but narrow — jbrowse-components does its own chaining
  (`shared/chainGroupingKey.ts`) and never sets `viewAsPairs`. A caller that
  wants both can filter before calling `fetchPairs`, which is public.

- **Technically breaking**, but shipped as a minor: the option is niche, and the
  only consumer found anywhere outside this repo was jbrowse-components, whose
  usage moved in the same pass.

## What changed on the jbrowse-components side

`BamAdapter.getFeatures` stopped passing `filterBy` into `getRecordsForRange`
and now applies `flagInclude`/`flagExclude` via its own `filterReadFlag` inside
the loop that already applies `readName` and `tagFilters` — three filter kinds
in one place, matching `CramAdapter.shouldFilterRecord`. Verified with the
plugin's full suite (1178 tests) and a repo typecheck.

One knock-on: `seqFetchSpan(records, …)` now sees flag-excluded reads, so the
reference span it computes can be marginally wider. It is already clamped to the
viewport and any single MD-less read sets it, so this is noise in practice.

Sequencing mattered in the other direction only: dropping the option from bam-js
_without_ moving jbrowse-components would have silently stopped applying the
flag masks, since the option is optional and its absence is not a type error.
