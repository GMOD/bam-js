# Benchmark Results Summary

This document tracks the performance improvements from optimizations.

## Micro-Optimizations Verified

### Sequence Parsing (src/record.ts seq getter)

- **Before**: Character-by-character with push
- **After**: Pre-allocated array, unrolled loop
- **Improvement**: 1.39x faster (from seq-optimization.bench.ts)

### Tag Name Creation (src/record.ts tags getter)

- **Before**: `String.fromCharCode(byte1, byte2)`
- **After**: `String.fromCharCode(byte1) + String.fromCharCode(byte2)`
- **Improvement**: 30.23x faster (from tags-optimization.bench.ts)

### Tag Type Parsing (src/record.ts tags getter)

- **Before**: if/else chain
- **After**: switch statement
- **Improvement**: 1.17x faster (from tags-optimization.bench.ts)

### Array Building (src/util.ts gen2array)

- **Before**: `.concat()` in loop (O(n²))
- **After**: `.push()` in nested loop (O(n))
- **Improvement**: Significant for large result sets

### Cache Performance (src/bamFile.ts)

- Repeated queries: 2.0x faster with cache
- Overlapping regions: 3.1x faster with cache

## Current Absolute Performance

### Field Access Times (volvox-sorted.bam, ctgA:1-50000)

- Basic fields (start, end, strand): ~36.7ms
- CIGAR (cached): ~31.8ms
- Sequence (cached, optimized): ~53.6ms
- Tags (cached, optimized): ~48.9ms
- All common fields: ~71.4ms

### Overall Query Performance

- Query + minimal access: ~27.8ms
- Query + full field access: ~69.4ms
- **Field parsing overhead: ~41.6ms**

## Optimizations Applied

### bamFile.ts

1. Hoisted `dpositions` check outside loop (line 368)
2. Hoisted `cpositions.length` check outside loop (line 369)
3. Replaced `.map()` with `for...of` loops (lines 274, 293)

### util.ts

4. Inlined `sum()` function
5. Fixed `gen2array()` O(n²) concat issue

### record.ts

6. Optimized `seq` getter - pre-allocated array, unrolled loop (1.39x faster)
7. Optimized tag name creation (30x faster)
8. Converted tags parser to switch statement (1.17x faster)

## Notes

- High variance in some benchmarks (up to 33% RME) - run multiple times for
  confidence
- Cache provides 2-3x speedup for typical genomics workloads
- Sequence and tags parsing remain the most expensive operations (as expected)
