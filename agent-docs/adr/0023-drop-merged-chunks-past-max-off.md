# ADR 0023 — Drop merged chunks that start past htslib's `max_off`

Status: Accepted, implemented. Changes what ADR 0010's early stop and ADR 0017's
byte forecast are left to do; both carry a note pointing here.

## Context

`blocksForRange` bounded a query's chunks from below only, with the linear
index. Every chunk of every bin overlapping the query survived, including the
ones holding nothing but records past its end, and the early stop (ADR 0010)
found those only by reading one. htslib bounds the query from the right as well,
from the binning index alone (`hts_itr_query`, hts.c): walk right from the
finest bin after the one holding `end - 1`, stepping up to the parent at every
first child. Each bin visited begins at or past `end`, so the first chunk of the
first one that exists is a record past the query, and in a coordinate-sorted
file so is everything after it. That offset is `max_off`, and `maxOffset` in
`indexFile.ts` computes it.

It is a bound rather than a forecast. It rests on the sort order `appendInRange`
and the early stop already assume, which is a different thing from the
linear-index forecast ADR 0017 declined to prune a fetch with: that one really
can drop records.

## Decision

Compute `max_off` in `IndexFile.blocksForRange`, for BAI and CSI alike (BAI is
CSI with `minShift` 14 and `depth` 5), and drop every **merged** chunk whose
`minv` is at or past it. Do not trim chunks at `max_off`, and do not drop raw
chunks before the merge.

The mate lookups in `fetchPairs` go through `blocksForRange` too, and get the
same pruning.

## Where in the pipeline: three variants measured

Bytes and requests with the chunk cache cleared before every query, 48 windows
per file from 400bp to 500kb spread over each file's data. Every variant
returned the same records in the same order in every window.

| file                      | before        | drop, then merge | merge, then drop (shipped) |
| ------------------------- | ------------- | ---------------- | -------------------------- |
| out.bam                   | 295.5MB / 269 | 209.7MB / 131    | 249.1MB / 131              |
| chr22_nanopore_subset.bam | 471.7MB / 290 | 409.6MB / 131    | 422.8MB / 131              |
| ultra-long-ont…subsel.bam | 285.6MB / 176 | 239.1MB / 76     | 252.1MB / 76               |
| volvox-sorted.bam         | 17.1MB / 69   | 15.6MB / 48      | 15.6MB / 48                |
| ecoli_nanopore.bam        | 47.9MB / 69   | 44.6MB / 48      | 44.6MB / 48                |

Dropping before the merge saves more bytes on a cold query: 29% against 16% on
out.bam. Requests fall by the same amount either way.

Trimming, htslib's own treatment, adds nothing to either. Across out.bam's 48
windows only 7 raw chunks straddle `max_off`, and trimming them saves 33KB: a
raw chunk is a run of one bin's records, the record at `max_off` belongs to
another bin, and a raw chunk crosses it only where htslib joined two of its
chunks through a shared BGZF block. So the parsing-review handoff's split
between trimming and dropping was really a split between before and after the
merge. Its trimmed figure for out.bam (−41%) matches the drop-then-merge column,
and its drop-only figure (−26%) the merge-then-drop one, over different windows.

## Why after the merge: panning

The merged chunk is the cache key (ADR 0019). Dropping before the merge ends
each merged chunk at the last raw chunk below `max_off`, which moves with the
query end, so every step of a pan mints a new key over bytes it has already
parsed. Total bytes over a pan with a warm cache, window/step/count:

| file                | pan          | before | drop, then merge | merge, then drop |
| ------------------- | ------------ | -----: | ---------------: | ---------------: |
| out.bam             | 5k/2.5k/16   |  9.1MB |     5.5MB (−39%) |     4.6MB (−49%) |
| out.bam             | 20k/5k/12    | 15.1MB |    12.5MB (−17%) |    10.3MB (−31%) |
| out.bam             | 50k/12.5k/12 | 22.9MB |    40.9MB (+79%) |    19.9MB (−13%) |
| out.bam             | 100k/25k/10  | 47.8MB |           47.7MB |     46.8MB (−2%) |
| chr22_nanopore      | 20k/5k/12    | 13.6MB |     8.9MB (−34%) |    10.0MB (−26%) |
| chr22_nanopore      | 50k/12.5k/12 | 25.1MB |     25.4MB (+1%) |    20.7MB (−17%) |
| chr22_nanopore      | 100k/25k/10  | 38.9MB |    45.8MB (+18%) |     35.9MB (−8%) |
| ultra-long-ont      | 50k/12.5k/12 |  6.9MB |     8.0MB (+17%) |            6.9MB |
| ultra-long-ont      | 100k/25k/10  | 12.8MB |     14.0MB (+9%) |           12.8MB |
| jb2bench 20x.short  | 5k/2.5k/16   |  2.3MB |     1.8MB (−19%) |     1.8MB (−19%) |
| jb2bench 2mb.100x.l | 100k/25k/10  | 62.0MB |    55.2MB (−11%) |    55.2MB (−11%) |

Merging first leaves exactly the chunks the query got before, under the same
keys, minus some. Over a pan it can therefore only read a subset of what it read
before, and across 13 files and four pan geometries it never read more. Dropping
first regressed five of those rows, by up to 79%. jbrowse queries each visible
region and re-queries as the view moves, so the pans are the case that matters.

The rest of jb2bench gains less: 2mb.100x.shortread 3-5%, 200x and 1000x
short-read 0.2-3%, and the whole-chromosome 20x, 200x and 1000x long-read files
nothing. On 1000x.longread htslib's `compress_binning` merged every 16kb bin
into its parent, leaving three bins. The one right of a first-half query starts
exactly where that query's last chunk ends, and a second-half query has none to
its right.

## Soundness

A merged chunk starting at or past `max_off` holds only records at or past it,
and every one of those starts at or past the query end. The drop needs the file
to be coordinate-sorted, which `appendInRange` and the early stop already
require. Checked rather than argued: the record list, compared by `fileOffset`
and in order, matched the old reader in every window of every run above, and the
samtools agreement suite passes.

## The early stop (ADR 0010) stays

No window in `test/data` fires it any more: `max_off` removes the chunks it used
to find. Real files still do. On jb2bench's 1000x.longread a 1kb window resolves
to 13 chunks and the stop reads 6; on 2mb.100x.longread, 7 and 6. The handoff
measured the stop saving 12% on 1000x.longread, where `max_off` prunes nothing.
The early-stop tests now supply their chunk list through
`test/lib/syntheticQuery.ts`, since no fixture gives them one.

## The byte forecast (ADR 0017), re-measured

`estimatedBytesForRegions` calls `blocksForRange`, so it inherits the pruning.
Over 64 windows per file from 1kb to 200kb, against the bytes a cold query read:

| file           | windows off by >5% | forecast ≠ sum of chunks | worst miss        |
| -------------- | -----------------: | -----------------------: | ----------------- |
| out.bam        |             17 → 1 |                   34 → 1 | −84%/+117% → −83% |
| chr22_nanopore |             37 → 3 |                   13 → 3 | −45%/+54% → −45%  |
| ultra-long-ont |             29 → 0 |                    0 → 0 | +27% → exact      |
| volvox, ecoli  |              0 → 0 |                    0 → 0 | exact             |

Summing every chunk `blocksForRange` returns now equals the bytes read in 316 of
those 320 windows. The other 4 are exactly the windows where `chunksLikelyRead`
still changes the answer, and it changes it downward, by up to 83%. On this
corpus it now fires only when it is wrong.

It stays for now. ADR 0017 was built for COLO829BL, a hosted 40x ONT BAM whose
narrow windows offered 43.5MB and read 7.8MB, and that file is not reproducible
offline. If `max_off` brings those windows down to what is read, as it did
chr22_nanopore's 22 chunks to 1, `chunksLikelyRead` and `getHighestChunk` should
go. The handoff's 27% undershoot on 1000x.longread is untouched by this change,
since `max_off` prunes nothing there, and was not re-measured.

## Reproducing

The scripts lived in a session scratchpad. They wrap a `LocalFile`'s `read` to
sum lengths and count calls, monkeypatch `index.blocksForRange` with each
variant, call `clearFeatureCache()` before every cold query, place windows over
the span between the first and last mapped read that `samtools view` reports,
and start each pan at the middle of that span.
