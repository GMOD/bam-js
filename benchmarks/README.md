# Benchmarks

This directory contains performance benchmarks for the bam-js library.

## Running Benchmarks

```bash
yarn bench                    # Run all benchmarks
yarn bench cache             # Run only cache benchmarks
yarn bench string-building   # Run only string building benchmarks
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

### cache-size.bench.ts

Tests different cache sizes to find the optimal maxSize configuration. Compares:
100, 500, 1000 (current), 2000, 5000

### field-access.bench.ts

Benchmarks the cost of accessing different record fields. Helps identify hot
paths and expensive getters. Tests:

- Basic fields (start, end, strand)
- CIGAR (cached getter)
- Sequence (cached getter)
- Tags (cached getter)
- Combined access patterns

### string-building.bench.ts

Compares different string building approaches for various string lengths:

- Character-by-character concatenation (current approach)
- TextDecoder with latin1 encoding
- TextDecoder with utf8 encoding
- Array join approach

Tests both short strings (read names) and long strings (sequences).

### parsing-strategies.bench.ts

Compares the overhead of different parsing strategies:

- Minimal record access (just counting)
- Position-only access
- Name access (string building)
- Heavy field access (sequence, CIGAR, tags)
- Streaming vs array-based iteration

### overall-performance.bench.ts

Real-world performance benchmarks using volvox-sorted.bam (short reads):

- Query with full field access
- Query with minimal access
- Full chromosome query

### overall-performance-long-reads.bench.ts

Real-world performance benchmarks using out.bam (long reads):

- Query 100kb region with various field access patterns
- Query 1Mb region with full field access
- Isolates sequence and tags parsing overhead

Long reads have longer sequences (typically 1-100kb vs 50-500bp for short reads),
so sequence parsing optimizations should show larger improvements here.
