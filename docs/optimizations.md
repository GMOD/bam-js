# Optimizations

Why the query path looks the way it does. The path itself is drawn in
[dataflow.md](dataflow.md).

Two costs dominate a query that finds nothing cached, and nearly everything
below is about one of them: inflating the BGZF blocks it fetched, and the
network round trip it pays per chunk. Building records out of those bytes is a
rounding error beside either — per query, min of 5
([ADR 0003](../agent-docs/adr/0003-where-bam-query-time-goes.md)):

| file                                    | fetch |    inflate | build records |
| --------------------------------------- | ----: | ---------: | ------------: |
| chr22_nanopore_subset (14.2MB → 24.4MB) | 12 ms | **172 ms** |        0.1 ms |
| shortreads_300x (5.2MB → 18.5MB)        | 12 ms |  **82 ms** |         15 ms |
| volvox-sorted (0.4MB → 2.5MB)           |  6 ms |       9 ms |          3 ms |

Inflate is the largest column on every fixture, and 70-90% of the query's wall
clock on the deep ones — that is the measurement behind the "decompression is
70-90%" shorthand these docs and the ADRs use. So: avoiding a re-inflate beats
any amount of parser tuning, and a micro-optimization in the record path has to
earn the right to be measured at all.

## Reading the index

### Parsed once, shared across callers

`.bai`/`.csi` is a whole-file read, parsed on the first query and memoized for
the life of the object.

It is shared rather than merely memoized: the parse runs under a signal of its
own and is cancelled only once every caller waiting on it has given up. A query
that pans away therefore cannot abort the index read that concurrent queries
depend on. The header is read the same way, and `indices(refId)` is separately
LRU-memoized so repeated lookups don't re-walk the parsed bytes.

### The linear index is packed, not objects

A human-sized reference has one entry per 16kb window — ~15k for chr1 — and a
`VirtualOffset` apiece costs roughly an order of magnitude more memory than two
parallel `Float64Array`s, retained for as long as the reference stays memoized.
Both consumers want the raw numbers anyway; `getLowestChunk` builds the one
`VirtualOffset` a query actually needs.

The first pass over the file exists only to find the minimum virtual offset —
where the header ends — so `minVirtualOffset` compares packed offsets in place
and allocates at most one object instead of one per entry. And an assembly of
unplaced scaffolds reaches the per-reference parse tens of thousands of times
(`cho.bam.bai`: 28751 references, 205 linear entries between them), so the empty
linear index is one shared array rather than a pair per reference.

## Choosing and fetching chunks

### Prune, merge, clamp and disjoin before fetching anything

`blocksForRange` collects a chunk per overlapping bin at every level of the
binning scheme, which is far more than a query reads. Before any I/O,
`optimizeChunks`:

- drops chunks ending at or before the linear-index floor, _before_ sorting;
- merges neighbours within 65KB (up to a 5MB span), so adjacent bins become one
  range request;
- trims overlaps, so no byte is fetched twice — and, more importantly, so no
  record is returned twice. Two bins can overlap inside one BGZF block while the
  merge declines to join them, which on `test/data/out.bam` had 5 of 6551
  records coming back duplicated.

`clampChunkEnds` then pulls each chunk's end down to the next known BGZF block
boundary rather than over-reading a full maximum-size block. Smaller fetches and
a smaller `estimatedBytesForRegions`, with no extra I/O.

Dropping the merge — on the theory that a consumer with a coalescing range cache
makes it redundant — is much worse for everyone else: a bare consumer goes from
6 reads to 95-378 on the same queries _and_ downloads more, because every small
chunk pays its own tail padding where a merged one amortizes it
([ADR 0011](../agent-docs/adr/0011-chunk-merging-stays-even-behind-a-range-cache.md)).

### A query's chunks go out together

One query spans ~15 chunks (14.8 on average for a 20kb window on the 18MB
`out.bam`) and each is its own range request, so reading them one after another
costs a round trip apiece — the dominant cost of a remote query, ahead of
decompression. At a 50ms RTT, modelled through jbrowse's own caching fetch
layer:

| file                  | requests | bytes  | sequential | concurrent |
| --------------------- | -------- | ------ | ---------- | ---------- |
| out.bam (14 chunks)   | 13 both  | 8.7MB  | 734 ms     | **192 ms** |
| chr22_nanopore_subset | 3 both   | 14.2MB | 277 ms     | **185 ms** |

Request and byte counts are identical in both columns, so this buys latency
without costing bandwidth. Six at a time, because that is the HTTP/1.1 per-host
connection cap browsers enforce — above it the requests queue in the browser
anyway while peak memory keeps growing. A one-chunk query skips the pool
entirely, since the closure, worker array and `Promise.all` are pure overhead on
a query that can take 0.2ms
([ADR 0008](../agent-docs/adr/0008-fetch-a-querys-chunks-concurrently.md)).

### Concurrent queries share one in-flight read

The cache only holds a chunk once its read _finishes_, so without this two
queries overlapping in time both download and both inflate it. That is not a
rare interleaving but the primary consumer's normal access pattern: jbrowse
renders a row of blocks and issues one `getRecordsForRange` per block with no
serialization, and those per-block ranges collapse onto very few chunk keys.

Eight adjacent 3kb windows on `shortreads_300x.bam` resolve to 3 distinct
chunks. Issued concurrently they cost 9 decompressions and 85.5MB inflated,
against 3 and 29.4MB serially — concurrency made the query _slower_ than doing
it one at a time (240ms vs 113ms). Sharing the in-flight read brings it to 3
decompressions and 86ms, i.e. faster than serial, as a caller fanning out
expects ([ADR 0007](../agent-docs/adr/0007-share-in-flight-chunk-reads.md)).

### The query stops once a chunk is past it

The BAI linear index is the only thing narrowing a query to its region, and on
long-read data it narrows nothing: one ultra-long read spanning a large span
pins the entry near the start of the file. So a narrow window inherits every
chunk of every overlapping bin — on `chr22_nanopore_subset.bam` a 10kb window is
22 chunks and 9.3MB, 66% of the file, to answer with **zero** records.

Chunks come back sorted by `minv` and a coordinate-sorted BAM stores records in
`(ref_id, start)` order, so a chunk whose first record is already past the query
has only past-the-query records behind it. Stopping there takes that 10kb window
from 22 chunks to 1.

What makes the stop deterministic is that past-ness is monotone in chunk index,
plus one barrier after the first batch of six. An earlier attempt checked the
stop inside the work-stealing pool, and a warm cache raced past it — the same
query read 6 chunks cold and 9 warm, so a repeat query did _more_ I/O than the
first. Only one barrier, because a query that gets through its first six chunks
without stopping is one that needs them; that caps the cost of being wrong at
0.92x-0.95x against 0.82x-0.88x for barriering every wave
([ADR 0010](../agent-docs/adr/0010-early-stop-once-a-chunk-is-past-the-query.md)).

### Forecasting a query costs no I/O

`estimatedBytesForRegions` answers "you are about to download a lot" from the
index alone, and it forecasts the chunks the query will _read_ rather than the
ones it could need — the same asymmetry as the early stop, seen from the other
side. Summing every chunk was 5.6x over on the narrow windows a reader spends
their time in, and did not fall as they zoomed in, so it warned on views costing
a fraction of what it claimed and told them to do the one thing that cannot help
([ADR 0017](../agent-docs/adr/0017-the-byte-estimate-forecasts-the-read-not-the-candidates.md)).

## Reading records

### A record is a view, and its fields decode on access

`readBamFeatures` only walks block sizes and allocates one object per record —
0.1-15ms per query above. Everything expensive is a lazy accessor the consumer
pays for only if it touches it, and `end`, `CIGAR` and `tags` memoize onto the
record once read. `name` deliberately does not: consumers read it about once, so
a cache would cost a field slot on every record and pin every name string for as
long as the chunk stays cached, to save zero decodes.

What each accessor costs the first time it is read, over a whole query's
records, is what says which of them are worth tuning (min of 5):

| fixture                   |  seq |  tags | CIGAR |  name |
| ------------------------- | ---: | ----: | ----: | ----: |
| shortreads_300x (53.6k)   | 51ms |  61ms |   5ms |  17ms |
| chr22_nanopore (757 long) | 16ms | 0.9ms |  68ms | 0.3ms |

So `seq` on short reads and `CIGAR` on long ones, and nothing else.

### `seq` and `CIGAR`

`seq` decodes four bases per iteration off a 65536-entry table below 300bp and
switches to a `Uint16Array` fill plus one `TextDecoder` above it — concat wins
by 2-4x below the crossover, the decoder by 5-8x above. The 4-base table is
built lazily and only after 1024 short decodes have gone through the process:
filling it costs ~6ms and retains ~2MB, which is a loss on a long-read file with
a short-read tail.

`CIGAR` appends the length and the op character separately rather than
concatenating them first, which avoids an intermediate cons string per op —
1.23-1.35x on long reads, where this accessor dominates. A precomputed op-char
table is _slower_ than `String.fromCharCode`, because V8 already hands back an
interned single-character string
([ADR 0012](../agent-docs/adr/0012-cram-js-decode-optimizations-mostly-do-not-transfer.md),
which also records six ports from cram-js that do not transfer here).

### One tag, not all of them

`getTag` walks the tag block for the one tag asked for; `record.tags` decodes
every unrelated NM/AS/ms/de on the read to answer the same question. `getTagAlt`
resolves an alias pair (MM/Mm, ML/Ml) in one pass instead of two, which matters
because `getTag(a) ?? getTag(b)` walks every tag twice on every read that has
neither — i.e. every read in a file without base modifications. jbrowse issues
exactly that lookup per record on every render, and it was 12.9% of the whole
query on 1000x short-read data, spent proving absence.

Values are decoded by char code below 32 bytes and `TextDecoder` above, since
the decoder's ~0.35µs of fixed setup dominates the 4-13 byte Z values that are
the common case. `B` array tags become typed-array views over the record's own
buffer whenever alignment allows, and are copied only when it does not.

## Mismatches

The reference is packed once per region, into BAM's own 4-bit alphabet, so the
walk compares it against a read's already-packed `NUMERIC_SEQ` a byte — two
bases — at a time, unpacking only the rare byte that differs. Packing is the
only per-base pass in the whole walk, which is why it belongs to the region and
not to the read.

`getRecordsForRange` calls `fetchReferenceSequence` at most once per query, for
the union span of the reads that lack an MD tag, and binds the result only to
reads it fully covers — a partial binding would be per-query state written onto
a record shared between queries
([ADR 0020](../agent-docs/adr/0020-a-bound-reference-must-cover-the-whole-read.md)).

The walk itself is jbrowse's, kept byte-for-byte equivalent because a port 10%
slower is not a port anyone can take. Two things around it: the window is
clamped to int32 rather than left at the ±Infinity an unwindowed walk passes in,
since every op compares against it and Infinity makes each of those a Float64
comparison; and the walk stops at the window's right edge instead of running to
the end of the CIGAR, which is what makes a whole chromosome stored as one BAM
read affordable to render a screenful of
([ADR 0021](../agent-docs/adr/0021-the-mismatch-walk-is-jbrowses-and-is-at-parity-with-it.md)).

## The chunk cache

Parsed chunks are kept, bounded by decompressed bytes rather than entry count —
records are views into their chunk's buffer, so one entry pins the whole thing
and a count says nothing about memory. Sized to hold several queries, not one:
below a single query's working set the cache does not degrade, it inverts, since
each chunk is evicted before the next pan can reuse it. Sizing, the idle sweep,
and why a consumer with many files needs a shared budget instead:
[caching.md](caching.md).

## Decompression

Inflate is in wasm because that is where the time is. libdeflate-in-wasm beats a
per-block JS inflate by 2.6-3.5x and sits at parity with native `zlib`, so there
is no faster codec to reach for; the remaining headroom is running blocks in
parallel, which is `bgzfWorkerPool`.

The boundary is crossed once per chunk read, never per record — a record would
have to be serialized back out of a wasm heap that only ever grows
([ADR 0022](../agent-docs/adr/0022-the-wasm-boundary-sits-at-the-bgzf-block.md)).
What happens on the other side of that call — one wasm call per chunk rather
than per block, how a chunk's blocks are split across workers, and what was
measured and rejected there — is
[bgzf-filehandle's own optimizations doc](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/optimizations.md).

## What the consumer has to do

Some of the biggest wins are not in this library at all, because they are
decisions about the process rather than about the file. What
[jbrowse-components](https://github.com/GMOD/jbrowse-components) does, as the
worked example:

- **One `bgzfWorkerPool` per JS context**, passed to every adapter — measured
  1.95x end to end on a 22-view pan/zoom over 1000x long-read data, real HTTP,
  headless Chrome, 4 workers, same 38,246 records either way. One per RPC worker
  rather than one per file, since that is the scope with spare cores. The blocks
  cross to the workers as transferables, so the fan-out costs one pass over the
  compressed bytes and needs no cross-origin isolation.
- **One `cacheBudget` per JS context**, likewise. `maxCacheBytes` is per file,
  and a browser holds one file per open track, so three deep tracks browsing
  eight windows retained 1109MB with every cache well under its own 1GB ceiling
  — nothing was bounding the sum. Dividing the ceiling by the track count is
  worse than doing nothing.
- **A coalescing range cache under the filehandle.** `RemoteFileWithRangeCache`
  fetches in 256KB aligned blocks, joins contiguous runs into one request and
  dedups in flight. It composes with the concurrent chunk fetch rather than
  fighting it — the byte counts above are identical with and without — because
  that layer dedups _bytes_ while the chunk cache dedups _decompression_. Its
  idle timeout is deliberately five times bam-js's, since compressed bytes are
  the cheap layer and are what stands between a re-read and a re-download once
  the parsed cache expires.
- **`recordClass` instead of a wrapper object**, so a read is one object rather
  than a record plus a wrapper around it: ~33-40 bytes per read retained, which
  on a deep pileup is the kind of memory that costs.
- **Filtering in a loop it was already running.** `filterBy` used to live here
  and saved no I/O and no decompression — by the time it ran the expensive work
  was done. The caller already visits every record, so filtering there is free
  ([ADR 0005](../agent-docs/adr/0005-move-filterby-to-the-caller.md)).
- **Overlapping the reference fetch with the alignment fetch**, once a file is
  known to hold reads without MD. `packReference` carries its own start, so a
  region packed before the records land still locates any read in itself — worth
  ~20% of an uncached query at a CDN-like RTT.
- **Gating on `estimatedBytesForRegions`** before issuing a query at all, which
  is the consumer that section above exists for.

## What is left

One waste, measured and not fixed: the cache is keyed on the _merged_ chunk
span, and merging depends on the query, so a pan whose windows overlap decodes
the same bytes under two keys. It is containment — one parse fully redoing
another — on shallow-to-moderate short-read files whose bin chunks abut,
including the volvox demo file, where a twelve-window pan decompresses 71% more
than it needs to. Deep long-read data is untouched at ordinary zoom.

Keying on raw chunks recovers exactly that and never costs bytes, but is parked
rather than pending: the fetch unit must stay merged for the I/O reasons above,
so one fetch would fill several cache entries — a change in
`@gmod/shared-read-cache` too — and entry counts rise up to 10x on the long-read
files that gain nothing. Numbers, the design that would work, and the variant
that looks obvious and is wrong:
[ADR 0019](../agent-docs/adr/0019-the-chunk-cache-key-slides-as-a-query-pans.md).

## Further reading

Every measurement here comes from an ADR in
[`agent-docs/adr/`](../agent-docs/adr/), which also records what was tried and
rejected — several of the obvious next optimizations have already been measured
as losses.
