# ADR 0022 — The wasm boundary sits at the BGZF block, and neither wider nor narrower

Status: Accepted (documents the existing split; rejects widening it)

## Context

`docs/img/dataflow.dot` marks five call sites as wasm, all of them in
`@gmod/bgzf-filehandle`: `unzip` for the header, for a CSI, and for an htsget
block; `unzipChunkSlice` for a query chunk; and the worker pool that
`unzipChunkSlice` fans blocks out to. Everything else, including index parsing,
record construction, field decoding and mismatch walking, is JavaScript. This
ADR records why the boundary sits there, because "port the parser to wasm too"
is the obvious next idea and it is wrong.

## Decision

Keep wasm confined to inflate. Cross the boundary once per chunk read, never per
record.

## Why inflate is in wasm

Inflate takes most of a cold query's time. Per-query times from ADR 0003, min of
5:

| file                                      |  read |      unzip | readBamFeatures |
| ----------------------------------------- | ----: | ---------: | --------------: |
| chr22_nanopore_subset (14.2 MB → 24.4 MB) | 12 ms | **172 ms** |          0.1 ms |
| shortreads_300x (5.2 MB → 18.5 MB)        | 12 ms |  **82 ms** |           15 ms |
| volvox-sorted (0.4 MB → 2.5 MB)           |  6 ms |       9 ms |            3 ms |

Inflate is 70–90% of a cold query on every fixture.

Wasm inflate is also much faster than the JS it replaced (`pako`, through
bgzf-filehandle 6.0.0; wasm arrived in 6.0.1). The benchmark compares it with a
per-block `inflateRaw`, which is what a pure-JS BGZF reader does, and with
node's native `zlib` as the reference floor. The benchmark is bgzf-filehandle's
`benchmarks/inflate.bench.ts` (`pnpm benchonly inflate`); read its `min` column
rather than the summary's mean, per the methodology note below:

| file                     | wasm libdeflate | pako per block | node zlib per block |
| ------------------------ | --------------: | -------------: | ------------------: |
| paired.bam (84 KB)       |         0.53 ms | 1.86 ms (3.5x) |      0.63 ms (1.2x) |
| T_ko.2bit.gz (518 KB)    |         1.90 ms | 5.03 ms (2.6x) |     1.73 ms (0.91x) |
| shortreads_300x (5.1 MB) |         38.7 ms |  123 ms (3.2x) |      48.0 ms (1.2x) |
| chr22_nanopore (14.1 MB) |         83.8 ms |  241 ms (2.9x) |      91.2 ms (1.1x) |

Wasm is 2.6–3.5x faster than JS and **at parity with native zlib**. Because the
zlib column shows wasm already matching native zlib, the remaining decompression
headroom is outside the codec, in running several blocks at once. The worker
pool does that, because BGZF blocks inflate independently, and it scales close
to linearly up to about four workers (bgzf-filehandle's `docs/worker-pool.md`).

## Why the parser is not

There are three reasons, in order of weight.

1. **A wasm parser would save almost nothing.** `readBamFeatures` is 0.1–15 ms
   against 82–172 ms of inflate, so even a free parser moves a cold query by
   single-digit percent.

2. **A record never crosses the boundary.** The decompressed buffer is copied
   out of the wasm heap once, and every `BamRecord` is a view into it. `end`,
   `CIGAR`, `seq` and `tags` are lazy accessors that decode from those bytes on
   access, and ADR 0003 shows a consumer typically touches a handful of them. A
   wasm parser would have to either serialize records back across the boundary
   (paying for fields nobody reads) or hand back a handle per field (a crossing
   per access, on the hot paths). Either is worse than reading the bytes in
   place.

3. **The wasm heap only ever grows.** `WebAssembly.Memory` never shrinks, so
   every byte routed through wasm is reserved for the life of the module. One
   inflate of one chunk can afford that, and a parser holding records could not.
   The same limit is why `unzip` checks the gzip/BGZF header in **JS** before
   calling in: rejecting a plain gzip file inside wasm would permanently reserve
   the file's size on the way to the error.

The same reasoning keeps index parsing in JS. A `.bai` parse is 2.2 ms on the
largest test index and is memoized per file (ADR 0003 §2). Of the index formats,
only a CSI goes through wasm, because a CSI is itself bgzip-compressed.

## Consequences

- The boundary count is O(chunks per query), not O(records). A query reading 15
  chunks makes 15 wasm calls, whatever the record count.
- `cpositions`/`dpositions` come back as the `Float64Array`s wasm produced and
  are consumed as `ArrayLike` here, so no copy into plain arrays is needed on
  either side of the boundary (`bamFile.ts` `readBamFeatures`).
- Parallelism is at the block level, in Web Workers, with one module per worker.
  The pool uses no wasm threads and no `SharedArrayBuffer`, so it needs no
  cross-origin isolation, and it measured at parity with SAB anyway.
- A wasm error path is fragile in a way that is not obvious from here; see
  bgzf-filehandle ADR 0002.

## Benchmarking note

Read the `min` column, not the mean vitest prints in its summary. As ADR 0003's
methodology section explains, this box often runs at a load average above 100,
where the tail is noise and the floor is the signal. The means and the minima
differ enough to matter: pako comes out 2.6–3.3x on the summary and 2.6–3.5x on
the minima.

Before timing any arm, the benchmark asserts that all three decompress to
identical bytes, so an arm that did less work fails instead of looking fast. The
benchmark does not alternate arm order the way a hand-rolled A/B must, because
vitest interleaves its own sampling. The hazard behind alternation is the one
bgzf-filehandle ADR 0001 records, where a sequential cold→warm comparison
measured a phantom 26% purely from CPU frequency ramp.
