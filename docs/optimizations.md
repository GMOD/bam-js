# Optimizations

This page gives the reasons and measurements behind each step of the query path.
[dataflow.md](dataflow.md) draws the path itself.

Two costs dominate a query that finds nothing cached: inflating the BGZF blocks
it fetched, and the network round trip for each chunk. Nearly every section
below addresses one of the two. Building records from the inflated bytes takes a
small fraction of either. The table gives the time per query, min of 5 runs
([ADR 0003](../agent-docs/architecture-decision-records/0003-where-bam-query-time-goes.md)):

| file                                    | fetch |    inflate | build records |
| --------------------------------------- | ----: | ---------: | ------------: |
| chr22_nanopore_subset (14.2MB → 24.4MB) | 12 ms | **172 ms** |        0.1 ms |
| shortreads_300x (5.2MB → 18.5MB)        | 12 ms |  **82 ms** |         15 ms |
| volvox-sorted (0.4MB → 2.5MB)           |  6 ms |       9 ms |          3 ms |

Inflate is the largest column on every fixture, and 70-90% of the query's wall
clock on the deep ones. Avoiding a second inflate of the same blocks therefore
saves more than any amount of parser tuning, and a micro-optimization in the
record path is rarely worth measuring in the first place.

## Reading the index

### Parsed once, shared across callers

The first query reads the whole `.bai`/`.csi`, parses it, and memoizes the
result for the life of the object.

Concurrent callers also share the parse while it runs. The parse has a separate
abort signal and aborts only once every caller waiting on it has given up, so a
query that pans away cannot abort an index read that other queries are waiting
for. bam-js reads the header the same way, and `indices(refId)` has a separate
LRU memo so repeated lookups don't walk the parsed bytes again.

### The linear index is packed into typed arrays

A human-sized reference has one linear-index entry per 16kb window, about 15k
for chr1. A `VirtualOffset` object per entry takes roughly an order of magnitude
more memory than two parallel `Float64Array`s, and the index keeps that memory
for as long as the reference stays memoized. `indexCov` and `clampChunkEnds`
need only the raw numbers, and `getLowestChunk` builds the one `VirtualOffset` a
query needs.

The first pass over the file needs only the minimum virtual offset, where the
header ends, so `minVirtualOffset` compares packed offsets in place and
allocates at most one object instead of one per entry. An assembly of unplaced
scaffolds runs the per-reference parse tens of thousands of times (`cho.bam.bai`
has 28751 references and 205 linear entries between them), so every reference
with an empty linear index shares one array instead of allocating a pair.

## Choosing and fetching chunks

### Prune, merge, clamp and disjoin before fetching anything

`blocksForRange` collects a chunk per overlapping bin at every level of the
binning scheme, which is far more than a query reads. Before any I/O,
`optimizeChunks`:

- drops chunks ending at or before the linear-index floor, _before_ sorting;
- merges neighbours within 65KB (up to a 5MB span), so adjacent bins become one
  range request;
- trims overlaps, so no fetch covers the same byte twice and, more importantly,
  no query returns a record twice. Two bins can overlap inside one BGZF block
  without the merge joining them, and on `test/data/out.bam` that duplicated 5
  of 6551 records.

`clampChunkEnds` then moves each chunk's end back to the next known BGZF block
boundary rather than over-reading by a full maximum-size block. The clamp
shrinks the fetches and the `estimatedBytesForRegions` total, and adds no I/O.

A consumer with a coalescing range cache might seem to make the merge redundant,
but dropping the merge is much worse for every other consumer. A consumer
without a range cache goes from 6 reads to 95-378 on the same queries _and_
downloads more, because each small chunk adds its own tail padding, where a
merged chunk adds it once
([ADR 0011](../agent-docs/architecture-decision-records/0011-chunk-merging-stays-even-behind-a-range-cache.md)).

### A query fetches its chunks concurrently

One query spans about 15 chunks (14.8 on average for a 20kb window on the 18MB
`out.bam`), and each chunk is a separate range request. Reading them one after
another costs a round trip per chunk, which is the largest cost of a remote
query, ahead of decompression. The table models a 50ms RTT through jbrowse's
caching fetch layer:

| file                  | requests | bytes  | sequential | concurrent |
| --------------------- | -------- | ------ | ---------- | ---------- |
| out.bam (14 chunks)   | 13 both  | 8.7MB  | 734 ms     | **192 ms** |
| chr22_nanopore_subset | 3 both   | 14.2MB | 277 ms     | **185 ms** |

Request and byte counts are identical in both columns, so concurrency lowers
latency without using more bandwidth. The pool fetches six chunks at a time, the
HTTP/1.1 per-host connection cap that browsers enforce; above six, the browser
queues the requests anyway while peak memory keeps growing. A one-chunk query
skips the pool, since the closure, worker array and `Promise.all` only add time
to a query that can take 0.2ms
([ADR 0008](../agent-docs/architecture-decision-records/0008-fetch-a-querys-chunks-concurrently.md)).

The concurrent fetch pool, which replaces a sequential `for` loop with an
`await`, is the largest piece of machinery in the library.
[ADR 0009](../agent-docs/architecture-decision-records/0009-why-the-concurrent-fetch-is-as-big-as-it-is.md)
explains each part of the pool and gives the cost of the sequential loop beside
it.

### Concurrent queries share one in-flight read

The cache stores a chunk only once its read _finishes_, so without sharing, two
queries that overlap in time both download and both inflate it. Overlapping
queries are jbrowse's normal access pattern, not a rare interleaving: jbrowse
renders a row of blocks and issues one `getRecordsForRange` per block without
waiting for the previous one, and those per-block ranges map to very few chunk
keys.

Eight adjacent 3kb windows on `shortreads_300x.bam` resolve to 3 distinct
chunks. Issued concurrently, the eight queries cost 9 decompressions and 85.5MB
inflated, against 3 and 29.4MB issued one at a time, so concurrency made them
_slower_ than serial (240ms vs 113ms). With the in-flight read shared, they cost
3 decompressions and 86ms, faster than serial, as a caller that issues queries
concurrently expects
([ADR 0007](../agent-docs/architecture-decision-records/0007-share-in-flight-chunk-reads.md)).

### The query stops once a chunk is past it

Only the BAI linear index narrows a query to its region, and on long-read data
it removes nothing: one ultra-long read covering a large span holds the entry
near the start of the file. A narrow window therefore reads every chunk of every
overlapping bin. On `chr22_nanopore_subset.bam`, a 10kb window reads 22 chunks
and 9.3MB, 66% of the file, and returns **zero** records.

The chunks are sorted by `minv`, and a coordinate-sorted BAM stores records in
`(ref_id, start)` order, so once a chunk's first record starts past the query,
every record after it does too. Stopping there takes that 10kb window from 22
chunks to 1.

Two things make the stop deterministic: whether a chunk is past the query is
monotone in chunk index, and the fetch waits at one barrier after the first
batch of six. An earlier attempt checked the stop inside the work-stealing pool,
where a warm cache made it stop later. The same query read 6 chunks cold and 9
warm, so a repeat query did _more_ I/O than the first. There is only one
barrier, because a query that gets through its first six chunks without stopping
needs them. The worst case, a query with more than six chunks and no stop, then
runs at 0.92x-0.95x, against 0.82x-0.88x with a barrier on every wave
([ADR 0010](../agent-docs/architecture-decision-records/0010-early-stop-once-a-chunk-is-past-the-query.md)).

### Forecasting a query costs no I/O

`estimatedBytesForRegions` computes from the index alone how many bytes a query
will download, so a consumer can warn before a large download. It counts the
chunks the query will _read_ rather than every chunk it could need. Summing
every chunk overestimated by 5.6x on the narrow windows where readers spend
their time, and the overestimate did not fall as they zoomed in, so the warning
fired on views that cost a fraction of the estimate
([ADR 0017](../agent-docs/architecture-decision-records/0017-the-byte-estimate-forecasts-the-read-not-the-candidates.md)).

## Reading records

### A record is a view, and its fields decode on access

`readBamFeatures` only walks block sizes and allocates one object per record,
which is the 0.1-15ms per query in the table above. Every expensive field is a
lazy accessor that decodes only when the consumer reads it, and `end`, `CIGAR`
and `tags` memoize onto the record after the first read. `name` is not memoized,
because consumers read it about once. A memo would add a field to every record
and keep every name string in memory for as long as the chunk stays cached, and
save no decodes.

The cost of each accessor on first access, summed over a whole query's records,
shows which accessors are worth tuning (min of 5):

| fixture                   |  seq |  tags | CIGAR |  name |
| ------------------------- | ---: | ----: | ----: | ----: |
| shortreads_300x (53.6k)   | 51ms |  61ms |   5ms |  17ms |
| chr22_nanopore (757 long) | 16ms | 0.9ms |  68ms | 0.3ms |

Only `seq` on short reads and `CIGAR` on long ones are worth tuning.

### `seq` and `CIGAR`

Below 300bp, `seq` decodes four bases per iteration from a 65536-entry table;
above 300bp it fills a `Uint16Array` and makes one `TextDecoder` call. The table
concat is 2-4x faster below the crossover, and the decoder 5-8x faster above it.
`seq` builds the 4-base table lazily, after the process has done 1024 short
decodes, because filling the table takes ~6ms and keeps ~2MB, which costs more
than it saves on a long-read file with a short-read tail.

`CIGAR` appends the length and the op character separately rather than
concatenating them first, which avoids an intermediate cons string per op and is
1.23-1.35x faster on long reads, where this accessor dominates. A precomputed
op-char table is _slower_ than `String.fromCharCode`, because V8 already returns
an interned single-character string
([ADR 0012](../agent-docs/architecture-decision-records/0012-cram-js-decode-optimizations-mostly-do-not-transfer.md),
which also records six ports from cram-js that do not transfer here).

### `getTag` decodes one tag

`getTag` walks the tag block for the one tag asked for, while `record.tags`
decodes every unrelated NM/AS/ms/de on the read to answer the same question.
`getTagAlt` looks up an alias pair (MM/Mm, ML/Ml) in one pass instead of two.
`getTag(a) ?? getTag(b)` walks every tag twice on every read that has neither
tag, which is every read in a file without base modifications. jbrowse makes
that lookup for each record on every render, and on 1000x short-read data it
took 12.9% of the whole query, all of it on reads that had neither tag.

Values below 32 bytes decode by char code and longer ones through `TextDecoder`,
because the decoder's ~0.35µs fixed setup outweighs the decode itself on the
4-13 byte Z values that are the common case. A `B` array tag becomes a
typed-array view over the record's buffer whenever alignment allows, and a copy
otherwise.

## Mismatches

The walk packs the reference once per region into BAM's 4-bit alphabet, so it
can compare the reference against a read's packed `NUMERIC_SEQ` one byte, two
bases, at a time, and unpack only the rare byte that differs. The packing is the
only per-base pass in the walk, which is why it runs once per region rather than
once per read.

`getRecordsForRange` calls `fetchReferenceSequence` at most once per query, for
the union span of the reads that lack an MD tag, and binds the result only to
reads it fully covers, because a partial binding would write per-query state
onto a record that queries share
([ADR 0020](../agent-docs/architecture-decision-records/0020-a-bound-reference-must-cover-the-whole-read.md)).

The walk is jbrowse's, kept byte-for-byte equivalent, with two changes around
it. bam-js clamps the window to int32 rather than leaving it at the ±Infinity an
unwindowed walk passes in, because every op compares against the window, and a
comparison against Infinity runs as a Float64 comparison rather than an int32
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

Inflate runs in wasm because inflate takes most of a query's time. libdeflate
compiled to wasm is 2.6-3.5x faster than a per-block JS inflate and matches
native `zlib`, so there is no faster codec to switch to. The remaining speedup
comes from inflating blocks in parallel, which `bgzfWorkerPool` does.

bam-js crosses the wasm boundary once per chunk read, never per record. A
per-record call would have to serialize each record back out of a wasm heap that
only ever grows
([ADR 0022](../agent-docs/architecture-decision-records/0022-the-wasm-boundary-sits-at-the-bgzf-block.md)).
[bgzf-filehandle's optimizations doc](https://github.com/GMOD/bgzf-filehandle/blob/main/docs/optimizations.md)
covers the other side of that call: one wasm call per chunk rather than per
block, how the pool splits a chunk's blocks across workers, and what its
measurements rejected.

## Streaming a whole file

`streamBamRecords` keeps `readAhead` window reads in flight at once, and the
gain comes from the depth. With one outstanding read, a round trip overlaps only
the CPU time spent on the window before it, and we measured no gain. Four
outstanding reads turn N sequential waits into roughly N/4: against a local
server that held each response for 20ms, an 18MB BAM streamed in 196ms at depth
4 against 519ms at depth 1, and at 100ms of latency in 1.9s against 7.4s. The
stream holds `depth` windows of compressed bytes at once, and can send up to
`depth - 1` wasted requests at the end of the file, because the length of a read
is the only sign that the file has ended.

The stream yields an array of records per window. A whole-file walk yields tens
of millions of records, and an async generator creates a promise per yield, so
yielding batches keeps the caller's inner loop synchronous.

`streamBamRecords` is a standalone function that shares the record and header
parsers with `BamFile` and nothing else, so a consumer who only streams bundles
neither `BAI`/`CSI` nor the chunk cache: 87KB minified against 111KB for
`BamFile`, over an identical wasm inflate bundle in both.

## Optimizations in the consumer

Some of the largest gains come from decisions a consumer makes about the whole
process rather than about one file, so this library cannot make them.
[jbrowse-components](https://github.com/GMOD/jbrowse-components) makes these:

- **One `bgzfWorkerPool` per JS context**, passed to every adapter. The pool
  measured 1.95x faster end to end on a 22-view pan/zoom over 1000x long-read
  data (real HTTP, headless Chrome, 4 workers, the same 38,246 records either
  way). jbrowse creates one pool per RPC worker rather than one per file, since
  the RPC worker is the scope with spare cores. The blocks go to the workers as
  transferables, so sending them costs one pass over the compressed bytes and
  needs no cross-origin isolation.
- **One `cacheBudget` per JS context**, also passed to every adapter.
  `maxCacheBytes` applies per file, and a browser opens one file per track, so
  three deep tracks browsing eight windows retained 1109MB while every cache
  stayed well under its 1GB ceiling. Dividing the ceiling by the track count is
  worse than doing nothing.
- **A coalescing range cache under the filehandle.** `RemoteFileWithRangeCache`
  fetches in 256KB aligned blocks, joins contiguous runs into one request and
  merges duplicate requests in flight. The range cache works alongside the
  concurrent chunk fetch rather than against it (the byte counts above are
  identical with and without it), because the range cache removes duplicate
  _byte fetches_ while the chunk cache removes duplicate _decompression_. Its
  idle timeout is five times bam-js's, because compressed bytes take less memory
  to keep. Once the parsed cache expires, a re-read still finds its bytes in the
  range cache instead of downloading them again.
- **`recordClass` instead of a wrapper object**, so each read is one object
  rather than a record plus a wrapper. The subclass saves ~33-40 bytes retained
  per read, which adds up on a deep pileup.
- **Filtering in a loop the consumer already runs.** bam-js used to define
  `filterBy`, which saved no I/O and no decompression, because both had already
  happened by the time it ran. The caller visits every record anyway, so
  filtering there adds no extra pass
  ([ADR 0005](../agent-docs/architecture-decision-records/0005-move-filterby-to-the-caller.md)).
- **Overlapping the reference fetch with the alignment fetch**, once you know a
  file has reads without MD. A `packReference` region stores its start, so a
  region packed before the records arrive can still resolve the position of any
  read within it. The overlap saves ~20% of an uncached query at a CDN-like RTT.
- **Gating on `estimatedBytesForRegions`** before issuing a query at all, as the
  forecasting section above describes.

## What is left

We measured one waste and have not fixed it. The cache keys on the _merged_
chunk span, and merging depends on the query, so a pan whose windows overlap
decodes the same bytes under two keys. The waste is containment, where one parse
fully redoes another, on shallow-to-moderate short-read files whose bin chunks
abut. On the volvox demo file, a twelve-window pan decompresses 71% more than it
needs to. Deep long-read data at ordinary zoom is unaffected.

Keying on raw chunks recovers exactly that waste and never fetches more bytes,
but the change is parked rather than pending. The fetch unit has to stay merged
for the I/O reasons above, so one fetch would fill several cache entries, which
needs a change in `@gmod/shared-read-cache` too. Entry counts would also rise up
to 10x on the long-read files that gain nothing.
[ADR 0019](../agent-docs/architecture-decision-records/0019-the-chunk-cache-key-slides-as-a-query-pans.md)
has the numbers, the design that would work, and the obvious-looking variant
that is wrong.

## Further reading

Every measurement here comes from an ADR in
[`agent-docs/architecture-decision-records/`](../agent-docs/architecture-decision-records/).
The ADRs also record what we tried and rejected, including several obvious next
optimizations that measured as losses.
