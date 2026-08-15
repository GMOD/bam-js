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

The diagram is the main path only. It leaves out htsget (which has no index and
joins at `readBamFeatures`), the `viewAsPairs` mate lookups and the
`fetchReferenceSequence` pass — both of which run after the records are
assembled and go back through the same chunk cache — and the early stop that
abandons the remaining chunks once one starts past the query.

## Where wasm sits

Everything orange is wasm, in
[`@gmod/bgzf-filehandle`](https://github.com/GMOD/bgzf-filehandle), and all of
it is decompressing BGZF blocks — reading the index and decoding records both
stay in JS.

That is where the time is: with nothing cached, 70-90% of the time it takes to
answer a query is spent decompressing, against 0.1-15ms for record construction.
libdeflate-in-wasm is 2.6-3.5x a per-block `pako` inflate while sitting at
parity with native `zlib`, so there is no faster codec left to reach for — the
remaining headroom is parallelism, which is the
[worker pool](../README.md#decompressing-on-a-worker-pool).

The boundary is crossed once per chunk, never per record: a record would have to
be serialized back out of the wasm heap, and that heap only ever grows. The full
argument, and the measurements behind it, are in
[ADR 0022](../agent-docs/adr/0022-the-wasm-boundary-sits-at-the-bgzf-block.md).
