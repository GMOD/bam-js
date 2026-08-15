# How a query flows

<img src="dataflow.svg" alt="bam-js data flow" width="700">

[dataflow.dot](dataflow.dot) is the source; see
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to re-render it.

A query resolves its reference name through the index and header, turns the
range into a list of BGZF chunks, and reads each chunk through
`chunkFeatureCache` — which shares a read already in flight and keeps parsed
chunks around, so a pan back over the same region does no I/O at all. Records
are views into their chunk's decompressed buffer; `seq`, `CIGAR`, `tags` and
friends decode on access, so a query costs what you read off it.

## Where wasm sits

Everything orange is wasm, in
[`@gmod/bgzf-filehandle`](https://github.com/GMOD/bgzf-filehandle), and it is
only ever inflate.

That is where the time is: decompression is 70-90% of a cold query, against
0.1-15ms for record construction. libdeflate-in-wasm is 2.6-3.5x a per-block
`pako` inflate while sitting at parity with native `zlib`, so there is no faster
codec left to reach for — the remaining headroom is parallelism, which is the
[worker pool](../README.md#decompressing-on-a-worker-pool).

The boundary is crossed once per chunk, never per record: a record would have to
be serialized back out of the wasm heap, and that heap only ever grows. The full
argument, and the measurements behind it, are in
[ADR 0022](../agent-docs/adr/0022-the-wasm-boundary-sits-at-the-bgzf-block.md).
