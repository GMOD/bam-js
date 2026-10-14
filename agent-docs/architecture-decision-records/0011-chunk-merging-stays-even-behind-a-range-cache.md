# ADR 0011 — Chunk merging stays, even for callers that have a coalescing range cache

Status: Accepted (rejects removing `optimizeChunks`' merge step; confirms its
65000 gap constant)

## Context

`optimizeChunks` merges chunks whose gap is under 65000 bytes, as long as the
combined span stays under 5MB. Both numbers were undocumented, and the merge
costs bytes: bridging a gap fetches data the query did not ask for.

There is a plausible argument that the merge step is now redundant. The
library's primary consumer reads through `RemoteFileWithRangeCache`, which
fetches in 256KB aligned blocks, joins contiguous runs of missing blocks into
one range request, de-duplicates in-flight fetches, and caches globally. That
layer is already a coalescer with a principled granularity. If the range cache
subsumes the merge, bam-js could drop an arbitrary heuristic and stop
over-fetching gap bytes.

The counter-argument is that consumers other than jbrowse use the merge too.
Node scripts and other tools use bam-js directly, with no caching layer at all,
and for them the merge is the only step that turns a scattered bin set into a
few requests.

## Measurement

We ran both policies over the real fixtures and asserted an identical record set
on every case. The records matched everywhere, and only the I/O changed. "Bare
consumer" is one `bam.read` per chunk straight to the transport. "Range cache"
models the real layer: 256KB-aligned blocks, with contiguous runs coalesced into
one request.

`m` = merging on (current), `u` = merging off.

| query          | chunks m/u | bare reads m/u | bare MB m/u   | cache req m/u | cache MB m/u  |
| -------------- | ---------- | -------------- | ------------- | ------------- | ------------- |
| chr22 10kb     | 22 / 55    | 6 / 6          | 6.03 / 5.58   | 2 / 2         | 7.00 / 6.50   |
| chr22 40kb     | 9 / 95     | **6 / 95**     | 11.69 / 14.80 | 1 / 2         | 12.25 / 13.25 |
| chr22 800kb    | 3 / 122    | **3 / 122**    | 13.63 / 18.07 | 1 / 1         | 13.49 / 13.49 |
| out.bam 20kb   | 26 / 161   | **6 / 161**    | 5.24 / 10.27  | **1 / 5**     | 6.25 / 13.25  |
| out.bam 500kb  | 21 / 218   | **6 / 218**    | 7.83 / 15.63  | **2 / 4**     | 8.50 / 13.75  |
| out.bam whole  | 4 / 378    | **4 / 378**    | 17.90 / 29.33 | 1 / 1         | 17.76 / 17.76 |
| shortreads 2Mb | 2 / 3      | 2 / 3          | 5.00 / 5.02   | 1 / 1         | 4.88 / 4.88   |
| volvox 5kb     | 3 / 4      | 3 / 4          | 0.31 / 0.37   | 1 / 1         | 0.38 / 0.38   |
| ultra-long 1Mb | 12 / 15    | 6 / 6          | 4.46 / 4.33   | 1 / 1         | 4.75 / 4.50   |

**Unmerged downloads more, not less.** This is the opposite of the intuition
that motivated the question. `Chunk.fetchedSize()` pads each chunk's tail by up
to a full BGZF block, because the compressed length of the block at `maxv` is
not recorded in the index. `clampChunkEnds` tightens that where a boundary is
known, but some padding remains. 378 small chunks each pay it; 4 merged ones
amortize it. `out.bam` whole goes 17.90MB → 29.33MB unmerged.

**The range cache does not make up the difference.** The cache joins only
_contiguous_ runs, so a scattered bin set stays scattered: `out.bam` 20kb goes
from 1 range request to 5, and 6.25MB to 13.25MB. Merging wins or ties on 7 of
the 10 queries even with the cache in front, and it is dramatically better for a
bare consumer on 5 of them (6 reads vs 95-378).

Unmerged is ahead only marginally and only on bytes, on the two narrow nanopore
windows (6.50MB vs 7.00MB) and ultra-long (4.33 vs 4.46). Those queries have an
identical request count either way, because the early stop already caps them at
6 reads.

## The gap constant

We swept the gap while the harness existed. Each cell is
`bare reads / bare MB, cache req / cache MB`:

| query          | gap=63KB (current)     | gap=256KB          | gap=1MB            |
| -------------- | ---------------------- | ------------------ | ------------------ |
| chr22 10kb     | **6 / 6.0, 2 / 7.0**   | 6 / 11.0, 4 / 12.8 | 3 / 12.7, 2 / 13.3 |
| chr22 40kb     | **6 / 11.7, 1 / 12.3** | 5 / 12.5, 2 / 13.3 | 3 / 13.5, 1 / 13.5 |
| out.bam 20kb   | **6 / 5.2, 1 / 6.3**   | 6 / 9.8, 4 / 11.5  | 4 / 13.9, 3 / 14.5 |
| out.bam 500kb  | **6 / 7.8, 2 / 8.5**   | 6 / 11.7, 3 / 12.8 | 4 / 13.9, 3 / 14.5 |
| volvox 5kb     | 3 / 0.3, 1 / 0.4       | 1 / 0.4, 1 / 0.4   | 1 / 0.4, 1 / 0.4   |
| ultra-long 1Mb | 6 / 4.5, 1 / 4.8       | 2 / 6.4, 1 / 6.4   | 2 / 6.4, 1 / 6.4   |

A 256KB gap matches the cache's own granularity, and would be the natural
refinement if the cache were the thing to optimize for. It nearly doubles the
bytes on `out.bam`'s narrow windows and quadruples its request count. 1MB is
worse still. Both directions from 65000 lose.

**Merging weakens the early stop.** The interaction is why a wider gap costs
more than the extra bridged bytes alone explain. A merged chunk is bigger, so it
is less likely to sit _wholly_ past the query, and the batch-and-stop from ADR
0010 fires later or not at all. Smaller chunks let the stop discriminate more
finely, and larger ones make it coarser. 65000 happens to fall at a good balance
between the two effects.

## Decision

Keep the merge step and keep 65000. A comment on `optimizeChunks` records the
rationale, so it is visible where the constants are.

Removing the merge step would optimize for one consumer's caching layer at the
direct expense of every other consumer, and would not pay off even for that
consumer.

## What would change the answer

- **If `fetchedSize()`'s tail padding went away** — say a future index format
  recorded the compressed length of the block at `maxv` — the "unmerged
  downloads more" result would weaken, since that padding is most of it.
- **If the early stop were removed or reworked**, the gap sweep would need
  redoing; half the penalty for a wider gap is the interaction with it.
- **If a consumer appeared that only ever reads through a coalescing cache**,
  merging could become a per-instance option rather than always-on. No current
  consumer justifies the extra API surface.
