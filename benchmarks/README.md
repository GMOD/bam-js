# Benchmarks

This directory contains performance benchmarks for the bam-js library.

## Running Benchmarks

```bash
yarn bench
```

## Available Benchmarks

### cache.bench.ts

Measures the performance impact of the BGZF block cache (`this.cache` in
BamFile).

**Results Summary:**

- Repeated queries (same region): **2.0x faster** with cache
- Overlapping region queries: **3.1x faster** with cache

The cache is especially effective when:

- Querying the same or overlapping genomic regions multiple times
- Fetching read pairs where mates are close together
- Panning/zooming in genome browsers
- Any workload with spatial locality of queries

Cache configuration: `maxSize: 1000` (in src/bamFile.ts)

The cache stores decompressed BGZF blocks, eliminating redundant decompression
when the same genomic regions are accessed multiple times.
