#!/usr/bin/env python3
"""Derive the two .bai fixtures used by the large-header tests.

Pm_st24_CTL1_subset.bam has an 11003-entry ref-seq table: 238229 bytes of
header text plus ~154KB of table, ~69KB compressed. Its samtools 1.23 index
backfills every linear-index window ahead of the file's first read (which
starts at S6:31099, window 1) with that read's offset, so firstDataLine lands
past the header and a single read covers it. Older indexers leave those
windows at 0 instead -- see test/data/HG00096_illumina_lowcov.bam.bai, whose
first three windows are 0 -- which is what broke jbrowse-components#5496.
These emulate that:

  *.leading_zeros.bam.bai    window 0 of each reference zeroed, as an indexer
                             that does not backfill would have written it
  *.no_linear_index.bam.bai  every window zeroed, so the index yields no
                             firstDataLine at all and the header read has to
                             grow on its own

Run from the repo root: python3 test/data/pha/make_index_fixtures.py
"""

import struct

SRC = 'test/data/pha/Pm_st24_CTL1_subset.bam.bai'
BIN_LIMIT = ((1 << 18) - 1) // 7


def linear_index_spans(data):
    """Byte offset and entry count of each reference's linear index."""
    pos = 4
    (n_ref,) = struct.unpack_from('<i', data, pos)
    pos += 4
    for _ in range(n_ref):
        (n_bin,) = struct.unpack_from('<i', data, pos)
        pos += 4
        for _ in range(n_bin):
            (b,) = struct.unpack_from('<I', data, pos)
            pos += 4
            if b == BIN_LIMIT + 1:
                pos += 4 + 32  # pseudo-bin: n_chunk plus two stats chunks
            else:
                (n_chunk,) = struct.unpack_from('<i', data, pos)
                pos += 4 + 16 * n_chunk
        (n_intv,) = struct.unpack_from('<i', data, pos)
        pos += 4
        yield pos, n_intv
        pos += 8 * n_intv


def rewrite(data, zeroed):
    out = bytearray(data)
    for start, n_intv in linear_index_spans(data):
        for j in range(n_intv if zeroed == 'all' else min(1, n_intv)):
            struct.pack_into('<Q', out, start + 8 * j, 0)
    return bytes(out)


data = open(SRC, 'rb').read()
assert data[:4] == b'BAI\x01'
for suffix, zeroed in [('leading_zeros', 'first'), ('no_linear_index', 'all')]:
    out = SRC.replace('.bam.bai', f'.{suffix}.bam.bai')
    open(out, 'wb').write(rewrite(data, zeroed))
    print('wrote', out)
