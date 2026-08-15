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

Why each of those steps looks the way it does, and what measured it, is
[optimizations.md](optimizations.md).

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

That is where the time is: with nothing cached, 70-90% of a query's wall clock
is spent decompressing, against 0.1-15ms building records. The boundary is
crossed once per chunk, never per record. Why it sits there, and why there is no
faster codec to reach for: [optimizations.md](optimizations.md#decompression).
