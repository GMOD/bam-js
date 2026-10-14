# ADR 0017 — `estimatedBytesForRegions` forecasts the read, not the candidates

Status: Accepted, implemented. Builds directly on ADR 0010 (the early stop).

> **Since ADR 0023** `blocksForRange` drops chunks past htslib's `max_off`, so
> the candidates this ADR forecasts from are mostly the chunks a query reads.
> Re-measured on the fixtures, `chunksLikelyRead` now changes the forecast in 4
> of 320 windows, and undershoots in all 4. The numbers below predate that, and
> ADR 0023 says what to check on COLO829BL before removing the forecast.

## Context

`estimatedBytesForRegions` summed `fetchedSize()` over every chunk
`blocksForRange` returned. Those chunks are the set a query _could_ need, which
on a long-read file is much larger than the set it reads. ADR 0010 is about the
same asymmetry, seen from the fetch side.

We measured COLO829BL (ONT R10, chr3, hosted), comparing the sum over every
chunk with the bytes `getRecordsForRange` pulls through an instrumented
filehandle:

| window | chunks | all chunks | actually read |
| ------ | ------ | ---------- | ------------- |
| 380bp  | 90     | 43.5MB     | 7.8MB         |
| 3.4kb  | 90     | 43.5MB     | 7.8MB         |
| 100kb  | 93     | 46.6MB     | 10.4MB        |
| 2Mb    | 91     | 155.9MB    | 155.9MB       |

The sum is 5.6x over on the narrow windows. Every window smaller than a
linear-index interval resolves to the same chunks, so the number does not fall
as the caller zooms in. The only consumer of this method is a "you are about to
download a lot" gate, so both properties mislead it in the same direction. The
gate warns on views that cost a fraction of what it claims, and it tells the
reader to zoom in, which cannot lower the number.

## Decision

Estimate the chunks the query will read, as the larger of two bounds:

- the prefix under a **linear-index bound**, `linearIndex[(max >> 14) + 1]`,
  which is the smallest offset of any record overlapping the window after the
  query. Chunks come back sorted by `minv`, so this is a prefix.
- **`MAX_CONCURRENT_CHUNK_READS`** chunks, because `_fetchChunkFeatures` reads
  its first batch before it can check the early stop, so no query costs less.

...unless the prefix is **empty**. An empty prefix means the bound falls at or
before the query's first chunk and orders nothing, so the estimate is every
chunk. The empty-prefix fallback makes the estimate safe, and it is why the rule
is not simply `max(bound, floor)`; see below.

| window                | before  | after      | actually read |
| --------------------- | ------- | ---------- | ------------- |
| COLO829BL 380bp/3.4kb | 43.5MB  | **7.8MB**  | 7.8MB         |
| COLO829BL 100kb       | 46.6MB  | **10.4MB** | 10.4MB        |
| COLO829BL 2Mb         | 155.9MB | 123.8MB    | 155.9MB       |
| out.bam 10kb          | 9.96MB  | **5.50MB** | 5.50MB        |
| chr22_nanopore 10kb   | 9.75MB  | 9.75MB     | 6.32MB        |
| volvox 10kb           | 0.32MB  | 0.32MB     | 0.32MB        |

The new estimate is never above the old number, and it is exact wherever it
changes except on the one 2Mb window, where it is 21% under. There the reader
over-reads chunks past the query, because it checks the stop once.

## Why the fetch may not use the same bound

The linear-index bound is an estimate, not a bound the reader could obey.
`linearIndex[w]` is the offset of the first record _overlapping_ window `w`. A
long read reaching into `w` from before it holds that entry at the long read's
low offset, so records that start later, and still before the query end, sit
above it. A fetch pruned at that offset would drop those records with no error.

The change is worth making only because a forecast tolerates error and a fetch
does not. A forecast that is sometimes 20% under warns slightly early, where a
fetch that is sometimes short returns wrong data. The approximation is therefore
defined in `chunksLikelyRead`, is reachable only from
`estimatedBytesForRegions`, and `blocksForRange` is untouched, so no query
returns a different record because of this change.

## What the empty-prefix fallback is for, and how it was found

We ported the same forecast to tabix-js, whose `getLines` has an even earlier
stop (it starts one chunk in flight and widens only after finishing one), and
measured it on the file JBrowse's own figures load: the **1000 Genomes SV
ensemble callset**, whose records include 1.4Mb deletions. Its linear-index
entry past a 5.5kb query sits exactly at that query's first chunk, because a
deletion spanning the window holds the entry there. The forecast came out at
**0.04MB against the 0.22MB the query reads**, a 5x under-estimate on a common
track, where the old behaviour had been exact.

Any feature much longer than the linear-index interval breaks this bound in the
same way, in tabix-js or anywhere else. An ONT read is ~24kb against a 16kb
interval, so BAM is exposed to a mild version of the failure, which is what the
2Mb row above shows. A 1.4Mb deletion spans 90 intervals, and the bound fails
completely.

An empty prefix marks that complete failure and means the index cannot order
these chunks, not that the query needs nothing. Falling back to every chunk
there restores the old behaviour, which is safe by construction. The fallback
costs no accuracy on any fixture but chr22_nanopore, where an ultra-long read
holds the 10kb window's entry low in the same way, so the estimate keeps summing
all 22 chunks and gives up the win.

**We reverted the port to tabix-js** instead of shipping it with the fallback.
The fallback fires on every long-feature file we measured there, so the change
would have been all risk and no win. In bam-js the fallback fires on one
fixture, and the real files keep the 5.6x improvement.

## Alternatives

- **Raise the consumer's ceiling instead.** jbrowse gates BAM at 5MB. A ceiling
  raised to admit 43.5MB would also apply to the CRAM path, whose estimate is
  accurate: 7.45MB claimed against 7.46MB read on the matched tumour file.
  cram-js sums CRAI slices, and it reads a slice whole, so its candidates and
  its reads are the same set. With the number fixed first, the ceiling can be
  set from real costs, and it should still be raised afterwards, because the
  irreducible cost of a 380bp window on these files is ~7.8MB.
- **Model the early stop by bin span** (stop at the first chunk whose bin
  extends past the query). The bin-span model predicts the same 6 chunks on the
  narrow windows, but it is a proxy for a record position rather than a
  measurement of one, and it needs a bin→range helper that nothing else in the
  index uses.
- **Read the first chunk and look.** The result is exact, but it is no longer an
  estimate, and `estimatedBytesForRegions` answers "should I download this"
  without downloading.
