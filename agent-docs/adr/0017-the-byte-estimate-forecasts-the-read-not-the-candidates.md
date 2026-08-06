# ADR 0017 — `estimatedBytesForRegions` forecasts the read, not the candidates

Status: Accepted, implemented. Builds directly on ADR 0010 (the early stop).

## Context

`estimatedBytesForRegions` summed `fetchedSize()` over every chunk
`blocksForRange` returned. That is the set of chunks a query _could_ need, which
on a long-read file is nothing like the set it reads — the same asymmetry ADR
0010 is about, seen from the other side.

Measured on COLO829BL (ONT R10, chr3, hosted), summing every chunk against the
bytes `getRecordsForRange` actually pulls through an instrumented filehandle:

| window | chunks | all chunks | actually read |
| ------ | ------ | ---------- | ------------- |
| 380bp  | 90     | 43.5MB     | 7.8MB         |
| 3.4kb  | 90     | 43.5MB     | 7.8MB         |
| 100kb  | 93     | 46.6MB     | 10.4MB        |
| 2Mb    | 91     | 155.9MB    | 155.9MB       |

5.6x over on the narrow windows, and — because every window smaller than a
linear-index interval resolves to the same chunks — the number does not fall as
the caller zooms in. The only consumer of this method is a "you are about to
download a lot" gate, so both properties are bad in the same direction: it warns
on views that cost a fraction of what it claims, and tells the reader to do the
one thing that cannot help.

## Decision

Estimate the chunks the query will read, as the larger of two bounds:

- the prefix under a **linear-index bound**, `linearIndex[(max >> 14) + 1]` —
  the smallest offset of any record overlapping the window after the query.
  Chunks come back sorted by `minv`, so this is a prefix.
- **`MAX_CONCURRENT_CHUNK_READS`** chunks, because `_fetchChunkFeatures` reads
  its first batch before it can check the early stop, so no query costs less.

...unless the prefix is **empty**, in which case the bound has landed at or
before the query's own first chunk and orders nothing, and the answer is every
chunk. That case is the whole safety story, and it is why this is not simply
`max(bound, floor)` — see below.

| window                | before  | after      | actually read |
| --------------------- | ------- | ---------- | ------------- |
| COLO829BL 380bp/3.4kb | 43.5MB  | **7.8MB**  | 7.8MB         |
| COLO829BL 100kb       | 46.6MB  | **10.4MB** | 10.4MB        |
| COLO829BL 2Mb         | 155.9MB | 123.8MB    | 155.9MB       |
| out.bam 10kb          | 9.96MB  | **5.50MB** | 5.50MB        |
| chr22_nanopore 10kb   | 9.75MB  | 9.75MB     | 6.32MB        |
| volvox 10kb           | 0.32MB  | 0.32MB     | 0.32MB        |

Never above the old number, exact where it moves at all, and 21% under on the
one 2Mb window — where the reader over-reads chunks past the query, because the
stop is checked once.

## Why the fetch may not use the same bound

The linear-index bound is an estimate, not a bound the reader could obey.
`linearIndex[w]` is the offset of the first record _overlapping_ window `w`, and
a long read reaching into `w` from before it pins that entry at its own low
offset — so records starting later, and still before the query end, sit above
it. Pruning a fetch there would silently drop records.

That asymmetry is the whole reason this is worth doing at all: a forecast that
is sometimes 20% under warns slightly early, where a fetch that is sometimes
short returns wrong data. So the approximation lives in `chunksLikelyRead`, is
reachable only from `estimatedBytesForRegions`, and `blocksForRange` is
untouched — no query returns a different record because of this change.

## What the empty-prefix fallback is for, and how it was found

The same forecast was ported to tabix-js, whose `getLines` has an even earlier
stop (it starts one chunk in flight and widens only after finishing one), and
measured on the file JBrowse's own figures load: the **1000 Genomes SV ensemble
callset**, whose records include 1.4Mb deletions. Its linear-index entry past a
5.5kb query sits exactly at that query's first chunk, because a deletion
spanning the window pins it there. The forecast came out at **0.04MB against the
0.22MB the query reads** — a 5x under-estimate on a common track, where the old
behaviour had been exact.

The failure is not tabix-specific; it is what a feature much longer than the
linear-index interval does to this bound anywhere. An ONT read is ~24kb against
a 16kb interval, so BAM is exposed to a mild version of it — which is what the
2Mb row above is. A 1.4Mb deletion is 90 intervals, and the bound collapses
completely.

An empty prefix is exactly that collapse: not "the query needs nothing", but
"this index cannot order these chunks". Deferring to every chunk there is the
old behaviour, which is safe by construction. It costs one fixture's win
(chr22_nanopore, whose 10kb window is pinned the same way by an ultra-long read
and keeps summing all 22 chunks) and no accuracy anywhere else.

**The port to tabix-js was reverted** rather than shipped with the fallback: the
fallback fires on every long-feature file measured there, so the change would
have been all risk and no win. bam-js is the opposite — the fallback fires on
one fixture and the real files keep the 5.6x.

## Alternatives

- **Raise the consumer's ceiling instead.** jbrowse gates BAM at 5MB, and a
  ceiling raised to swallow 43.5MB would also swallow the CRAM path, whose
  estimate is honest (7.45MB claimed against 7.46MB read on the matched tumour
  file — cram-js sums CRAI slices, and a slice is read whole, so its candidates
  and its reads are the same set). Fixing the number first is what lets that
  ceiling be set from real costs — and it still wants raising afterwards,
  because the irreducible cost of a 380bp window on these files is ~7.8MB.
- **Model the early stop by bin span** (stop at the first chunk whose bin
  extends past the query). Predicts the same 6 chunks on the narrow windows, but
  is a proxy for a record position rather than a measurement of one, and needs a
  bin→range helper the index otherwise has no use for.
- **Read the first chunk and look.** Exact, and no longer an estimate: the
  method exists to answer "should I download this" without downloading.
