# Optimizations

This page gives the reasons and measurements behind each step of the query path.
[dataflow.md](dataflow.md) draws the path itself.

Two costs dominate a query that finds nothing cached: inflating the BGZF blocks
it fetched, and the network round trip it pays per chunk. Nearly everything
below is about one of them. Building records out of those bytes takes a small
fraction of either. The table gives the time per query, min of 5 runs
([ADR 0003](../agent-docs/architecture-decision-records/0003-where-bam-query-time-goes.md)):

| file                                    | fetch |    inflate | build records |
| --------------------------------------- | ----: | ---------: | ------------: |
| chr22_nanopore_subset (14.2MB → 24.4MB) | 12 ms | **172 ms** |        0.1 ms |
| shortreads_300x (5.2MB → 18.5MB)        | 12 ms |  **82 ms** |         15 ms |
| volvox-sorted (0.4MB → 2.5MB)           |  6 ms |       9 ms |          3 ms |

Inflate is the largest column on every fixture, and 70-90% of the query's wall
clock on the deep ones, so avoiding a re-inflate beats any amount of parser
tuning.

## Reading the index

### Parsed once, shared across callers

The first query reads the whole `.bai`/`.csi`, parses it, and memoizes the
result for the life of the object.

Concurrent callers also share the parse while it is in flight. It runs under a
signal of its own and aborts only once every caller waiting on it has given up,
so a query that pans away cannot abort the index read concurrent queries depend
on. bam-js reads the header the same way, and `indices(refId)` is separately
LRU-memoized so repeated lookups don't re-walk the parsed bytes.

### The linear index is packed, not objects

A human-sized reference has one entry per 16kb window, ~15k for chr1. A
`VirtualOffset` apiece costs roughly an order of magnitude more memory than two
parallel `Float64Array`s, retained for as long as the reference stays memoized.
`indexCov` and `clampChunkEnds` need the raw numbers anyway, and
`getLowestChunk` builds the one `VirtualOffset` a query needs.

The first pass over the file finds only the minimum virtual offset, where the
header ends, so `minVirtualOffset` compares packed offsets in place and
allocates at most one object instead of one per entry. An assembly of unplaced
scaffolds reaches the per-reference parse tens of thousands of times
(`cho.bam.bai` has 28751 references and 205 linear entries between them), so the
empty linear index is one shared array rather than a pair per reference.

## Choosing and fetching chunks

### Prune, merge, clamp and disjoin before fetching anything

`blocksForRange` collects a chunk per overlapping bin at every level of the
binning scheme, which is far more than a query reads. Before any I/O,
`optimizeChunks`:

- drops chunks ending at or before the linear-index floor, _before_ sorting;
- merges neighbours within 65KB (up to a 5MB span), so adjacent bins become one
  range request;
- trims overlaps, so no fetch covers the same byte twice and, more importantly,
  so no record comes back twice. Two bins can overlap inside one BGZF block
  while the merge declines to join them, which on `test/data/out.bam` had 5 of
  6551 records coming back duplicated.

`clampChunkEnds` then pulls each chunk's end down to the next known BGZF block
boundary rather than over-reading a full maximum-size block. The clamp gives
smaller fetches and a smaller `estimatedBytesForRegions`, with no extra I/O.

A consumer with a coalescing range cache might seem to make the merge redundant,
but dropping the merge is much worse for everyone else. A consumer without a
range cache goes from 6 reads to 95-378 on the same queries _and_ downloads
more, because every small chunk adds its own tail padding where a merged one
amortizes it
([ADR 0011](../agent-docs/architecture-decision-records/0011-chunk-merging-stays-even-behind-a-range-cache.md)).

### A query's chunks go out together

One query spans ~15 chunks (14.8 on average for a 20kb window on the 18MB
`out.bam`), and each is its own range request, so reading them one after another
costs a round trip apiece, which is the dominant cost of a remote query, ahead
of decompression. The table models a 50ms RTT through jbrowse's own caching
fetch layer:

| file                  | requests | bytes  | sequential | concurrent |
| --------------------- | -------- | ------ | ---------- | ---------- |
| out.bam (14 chunks)   | 13 both  | 8.7MB  | 734 ms     | **192 ms** |
| chr22_nanopore_subset | 3 both   | 14.2MB | 277 ms     | **185 ms** |

Request and byte counts are identical in both columns, so concurrency lowers
latency without costing bandwidth. The pool fetches six chunks at a time because
browsers cap HTTP/1.1 at six connections per host; above six, the browser queues
the requests anyway while peak memory keeps growing. A one-chunk query skips the
pool entirely, since the closure, worker array and `Promise.all` are pure
overhead on a query that can take 0.2ms
([ADR 0008](../agent-docs/architecture-decision-records/0008-fetch-a-querys-chunks-concurrently.md)).

The concurrent fetch pool is the largest piece of machinery in the library.
[ADR 0009](../agent-docs/architecture-decision-records/0009-why-the-concurrent-fetch-is-as-big-as-it-is.md)
goes through each piece against a sequential `for` loop with an `await`.

### Concurrent queries share one in-flight read

The cache only holds a chunk once its read _finishes_, so without sharing, two
queries overlapping in time both download and both inflate it. Overlapping
queries are jbrowse's normal access pattern, not a rare interleaving: jbrowse
renders a row of blocks and issues one `getRecordsForRange` per block with no
serialization, and those per-block ranges map to very few chunk keys.

Eight adjacent 3kb windows on `shortreads_300x.bam` resolve to 3 distinct
chunks. Issued concurrently, they cost 9 decompressions and 85.5MB inflated,
against 3 and 29.4MB serially, so concurrency made the query _slower_ than doing
it one at a time (240ms vs 113ms). With the in-flight read shared, they cost 3
decompressions and 86ms, faster than serial, as a caller fanning out expects
([ADR 0007](../agent-docs/architecture-decision-records/0007-share-in-flight-chunk-reads.md)).

### The query stops once a chunk is past it

The BAI linear index is the only thing narrowing a query to its region, and on
long-read data it narrows nothing: one ultra-long read covering a large span
holds the entry near the start of the file. A narrow window therefore reads
every chunk of every overlapping bin. On `chr22_nanopore_subset.bam`, a 10kb
window reads 22 chunks and 9.3MB, 66% of the file, and returns **zero** records.

Chunks come back sorted by `minv`, and a coordinate-sorted BAM stores records in
`(ref_id, start)` order, so once a chunk's first record starts past the query,
every record after it does too. Stopping there takes that 10kb window from 22
chunks to 1.

Two things make the stop deterministic: whether a chunk is past the query is
monotone in chunk index, and the fetch waits at one barrier after the first
batch of six. An earlier attempt checked the stop inside the work-stealing pool,
where a warm cache made it stop later. The same query read 6 chunks cold and 9
warm, so a repeat query did _more_ I/O than the first. There is only one
barrier, because a query that gets through its first six chunks without stopping
needs them, which caps the cost of being wrong at 0.92x-0.95x, against
0.82x-0.88x with a barrier on every wave
([ADR 0010](../agent-docs/architecture-decision-records/0010-early-stop-once-a-chunk-is-past-the-query.md)).

### Forecasting a query costs no I/O

`estimatedBytesForRegions` computes from the index alone how many bytes a query
will download, so a consumer can warn before a large download. It forecasts the
chunks the query will _read_ rather than the ones it could need. Summing every
chunk was 5.6x over on the narrow windows a reader spends their time in, and the
overestimate did not fall as they zoomed in, so the warning fired on views
costing a fraction of the estimate
([ADR 0017](../agent-docs/architecture-decision-records/0017-the-byte-estimate-forecasts-the-read-not-the-candidates.md)).

## Reading records

### A record is a view, and its fields decode on access

`readBamFeatures` only walks block sizes and allocates one object per record,
which is the 0.1-15ms per query in the table above. Every expensive field is a
lazy accessor that decodes only when the consumer reads it, and `end`, `CIGAR`
and `tags` memoize onto the record once read. `name` is deliberately not
memoized, because consumers read it about once. A cache would cost a field slot
on every record and keep every name string in memory for as long as the chunk
stays cached, to save zero decodes.

The cost of each accessor's first touch, over a whole query's records (min of
5):

| fixture                   |  seq |  tags | CIGAR |  name |
| ------------------------- | ---: | ----: | ----: | ----: |
| shortreads_300x (53.6k)   | 51ms |  61ms |   5ms |  17ms |
| chr22_nanopore (757 long) | 16ms | 0.9ms |  68ms | 0.3ms |

Only `seq` on short reads and `CIGAR` on long ones are worth tuning.

### `seq` and `CIGAR`

`seq` decodes four bases per iteration off a 65536-entry table below 300bp and
switches to a `Uint16Array` fill plus one `TextDecoder` above it. Concat wins by
2-4x below the crossover, and the decoder by 5-8x above. `seq` builds the 4-base
table lazily, and only after 1024 short decodes have gone through the process,
because filling it costs ~6ms and retains ~2MB, which is a loss on a long-read
file with a short-read tail.

`CIGAR` appends the length and the op character separately rather than
concatenating them first, which avoids an intermediate cons string per op and is
about 1.3x faster on long reads, where this accessor dominates. A precomputed
op-char table is _slower_ than `String.fromCharCode`, because V8 already returns
an interned single-character string
([ADR 0012](../agent-docs/architecture-decision-records/0012-cram-js-decode-optimizations-mostly-do-not-transfer.md),
which also records six ports from cram-js that do not transfer here).

### One tag, not all of them

`getTag` walks the tag block for the one tag asked for, while `record.tags`
decodes every unrelated NM/AS/ms/de on the read to answer the same question.
`getTagAlt` resolves an alias pair (MM/Mm, ML/Ml) in one pass instead of two,
which matters because `getTag(a) ?? getTag(b)` walks every tag twice on every
read that has neither tag, which is every read in a file without base
modifications. jbrowse issues exactly that lookup per record on every render,
and on 1000x short-read data it was 12.9% of the whole query, all of it on reads
that had neither tag.

Values below 32 bytes decode by char code and longer ones through `TextDecoder`,
since the decoder's ~0.35µs of fixed setup dominates the 4-13 byte Z values that
are the common case. `B` array tags become typed-array views over the record's
own buffer whenever alignment allows, and copy only when it does not.

## Mismatches

The walk packs the reference once per region into BAM's own 4-bit alphabet, so
it can compare against a read's already-packed `NUMERIC_SEQ` a byte (two bases)
at a time, unpacking only the rare byte that differs. That packing is the walk's
only per-base pass, and it runs once per region rather than once per read.

`getRecordsForRange` calls `fetchReferenceSequence` at most once per query, for
the union span of the reads that lack an MD tag, and binds the result only to
reads it fully covers, because a partial binding would be per-query state
written onto a record shared between queries
([ADR 0020](../agent-docs/architecture-decision-records/0020-a-bound-reference-must-cover-the-whole-read.md)).

The walk itself is jbrowse's, kept byte-for-byte equivalent, with two changes
around it. bam-js clamps the window to int32 rather than leaving it at the
±Infinity an unwindowed walk passes in, since every op compares against it, and
a comparison against Infinity runs as a Float64 comparison rather than an int32
one. The walk also stops at the window's right edge instead of running to the
end of the CIGAR, so a renderer can draw a screenful of a whole chromosome
stored as one BAM read without walking the rest of its CIGAR
([ADR 0021](../agent-docs/architecture-decision-records/0021-the-mismatch-walk-is-jbrowses-and-is-at-parity-with-it.md)).

## The chunk cache

The cache holds parsed chunks and bounds itself by decompressed bytes rather
than entry count. Records are views into their chunk's buffer, so one entry
keeps the whole buffer in memory, and an entry count says nothing about memory.
Size the cache to hold several queries, not one. Below a single query's working
set, the cache evicts each chunk before the next pan can reuse it, so the hit
rate drops to zero rather than falling gradually. [caching.md](caching.md)
covers sizing, the idle sweep, and why a consumer with many files needs a shared
budget instead.

## Decompression

Inflate is in wasm because that is where the time is. libdeflate compiled to
wasm beats a per-block JS inflate by 2.6-3.5x and matches native `zlib`, so
there is no faster codec to reach for. The remaining headroom is in running
blocks in parallel, which `bgzfWorkerPool` does.

A call crosses the boundary once per chunk read, never per record. Per record,
the call would have to serialize each one back out of a wasm heap that only ever
grows
([ADR 0022](../agent-docs/architecture-decision-records/0022-the-wasm-boundary-sits-at-the-bgzf-block.md)).
[bgzf-filehandle's optimizations doc](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/optimizations.md)
covers the other side of that call: one wasm call per chunk rather than per
block, how the pool splits a chunk's blocks across workers, and what its
measurements rejected.

### A pooled chunk is parsed in segments, not joined

`_readChunkFeatures` reads a chunk with `unzipChunkSegments`, so a pooled chunk
arrives as one buffer per worker. Joining them was a serial copy of the whole
chunk on the calling thread. `readBamFeatures` parses each segment in place and
copies only a record that straddles two.

Cold `getRecordsForRange` in headless Chrome on an i9-12900K, four workers, min
of 15, two runs, both builds on bgzf-filehandle 6.8.0:

| query                      | records | segments vs joined |
| -------------------------- | ------- | ------------------ |
| volvox-sorted ctgA:0-100k  | 9,596   | 1.18-1.42x         |
| shortreads_300x 10kb       | 11,199  | 1.20-1.31x         |
| shortreads_300x 100kb      | 53,596  | 1.29-1.38x         |
| chr22_nanopore 100kb       | 35      | 1.10-1.12x         |
| chr22_nanopore 800kb       | 757     | 1.11-1.13x         |
| ultra-long-ont 9:135-137Mb | 75      | 1.20-1.22x         |

Against no pool, the same queries went from 1.3-2.2x to 1.5-2.5x.

## Streaming a whole file

`streamBamRecords` keeps `readAhead` window reads in flight at once, and the
gain comes from the depth. With one outstanding read, a round trip overlaps only
the CPU time spent on the window before it, and we measured no gain. Four
outstanding reads turn N sequential waits into roughly N/4: over a local server
holding each response for 20ms, an 18MB BAM walked in 196ms at depth 4 against
519ms at depth 1, and at 100ms of latency in 1.9s against 7.4s. The cost is
`depth` windows of compressed bytes held at once, and up to `depth - 1` wasted
requests at the end of the file, because the length of a read is the only sign
that the file has ended.

The stream yields an array of records per window. A whole-file walk is tens of
millions of records, and an async generator creates a promise per yield, so
batching keeps the caller's inner loop synchronous.

`streamBamRecords` is a standalone function that shares the record and header
parsers with `BamFile` and nothing else, so a consumer who only streams bundles
neither `BAI`/`CSI` nor the chunk cache: 87KB minified against 111KB for
`BamFile`, over an identical wasm inflate bundle in both.

## What the consumer has to do

Some of the biggest wins come from decisions about the whole process rather than
one file, so this library cannot make them.
[jbrowse-components](https://github.com/GMOD/jbrowse-components) makes these:

- **One `bgzfWorkerPool` per JS context**, passed to every adapter. We measured
  it at 1.95x end to end on a 22-view pan/zoom over 1000x long-read data (real
  HTTP, headless Chrome, 4 workers, same 38,246 records either way). jbrowse
  creates one pool per RPC worker rather than one per file, since the RPC worker
  is the scope with spare cores. The blocks cross to the workers as
  transferables, so the fan-out costs one pass over the compressed bytes and
  needs no cross-origin isolation.
- **One `cacheBudget` per JS context**, also passed to every adapter.
  `maxCacheBytes` is per file, and a browser holds one file per open track, so
  three deep tracks browsing eight windows retained 1109MB with every cache well
  under its own 1GB ceiling. Dividing the ceiling by the track count is worse
  than doing nothing.
- **A coalescing range cache under the filehandle.** `RemoteFileWithRangeCache`
  stores the byte extents it fetched, merges the gaps nearby reads leave into
  one request and dedups in flight. It composes with the concurrent chunk fetch instead of
  conflicting with it (the byte counts above are identical with and without it),
  because the range cache dedups _bytes_ while the chunk cache dedups
  _decompression_. Its idle timeout is deliberately five times bam-js's, because
  compressed bytes take less memory to keep. Once the parsed cache expires, a
  re-read still hits the range cache instead of triggering a re-download.
- **`recordClass` instead of a wrapper object**, so a read is one object rather
  than a record plus a wrapper around it. That saves ~33-40 bytes per read
  retained, which adds up on a deep pileup.
- **Filtering in a loop the consumer was already running.** bam-js used to
  define `filterBy`, which saved no I/O and no decompression, because by the
  time it ran, the expensive work had already happened. The caller visits every
  record anyway, so filtering there adds no extra pass
  ([ADR 0005](../agent-docs/architecture-decision-records/0005-move-filterby-to-the-caller.md)).
- **Overlapping the reference fetch with the alignment fetch**, once you know a
  file holds reads without MD. A `packReference` region stores its start, so a
  region packed before the records arrive can still resolve the position of any
  read within it. The overlap saves ~20% of an uncached query at a CDN-like RTT.
- **Gating on `estimatedBytesForRegions`** before issuing a query at all, as the
  forecasting section above describes.

## The chunk cache key slides as a query pans

We measured one waste and have not fixed it. The cache keys on the _merged_
chunk span, and merging depends on the query, so a pan whose windows overlap
decodes the same bytes under two keys. The waste is containment (one parse fully
redoing another) on shallow-to-moderate short-read files whose bin chunks abut,
including the volvox demo file, where 71% of what a twelve-window pan
decompresses is waste. It does not affect deep long-read data at ordinary zoom.

Keying on raw chunks recovers exactly that waste and never costs bytes, but the
fetch unit must stay merged for the I/O reasons above, so one fetch would fill
several cache entries, and entry counts would rise on the long-read files. A
canonical partition of the index avoids both costs: it has fewer entries than
the merged key, and one fetch fills one entry, so `@gmod/shared-read-cache`
needs no change. Nobody has built it yet.
[ADR 0019](../agent-docs/architecture-decision-records/0019-the-chunk-cache-key-slides-as-a-query-pans.md)
has the numbers, the design that would work, and the variant that looks obvious
and is wrong.

## Further reading

Every measurement here comes from an ADR in
[`agent-docs/architecture-decision-records/`](../agent-docs/architecture-decision-records/).
The ADRs also record what we tried and rejected, including several obvious next
optimizations that measured as losses.
