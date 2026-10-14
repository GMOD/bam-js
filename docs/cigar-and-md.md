# CIGAR, MD, and how the walk decodes mismatches

This page explains the two fields that `getMismatches` and `forEachMismatch`
read. The API reference is [api.md](api.md#mismatches).

## CIGAR

CIGAR describes how the read aligns, in order, as a run-length list of ops. Each
op has a length and a letter, and each consumes read bases, reference bases, or
both:

| op  | meaning                 | read | ref |
| --- | ----------------------- | ---- | --- |
| `M` | aligned, bases unstated | yes  | yes |
| `=` | aligned and equal       | yes  | yes |
| `X` | aligned and different   | yes  | yes |
| `I` | insertion into the read | yes  | no  |
| `D` | deletion from the read  | no   | yes |
| `N` | reference skip (intron) | no   | yes |
| `S` | soft clip, bases kept   | yes  | no  |
| `H` | hard clip, bases gone   | no   | no  |
| `P` | padding                 | no   | no  |

`M` means "aligned", not "matching". Most aligners emit `M` for both, so the
CIGAR alone locates indels and clips but not substitutions. `--eqx`-style
aligners emit `=`/`X` instead, and those ops mark the substitutions.

BAM stores the op count in 16 bits, so a read with more than 65535 ops keeps a
`<seqlen>S<reflen>N` placeholder in the record and the real CIGAR in a `CG` tag.
`record.CIGAR` and `record.NUMERIC_CIGAR` return the real CIGAR from the tag.

## MD

MD is an aux tag that fills in what `M` leaves out, over the aligned bases that
consume the reference. A number is that many matching bases, a letter is a
reference base the read differs from, and `^` plus letters lists the reference
bases a `D` op deleted. Insertions, clips and `N` never appear in it.

## A worked example

A read at `chr1:100` (0-based) with:

```
CIGAR  5M1I4M2D3M
SEQ    ACGGTCAACGTTA
MD     3A5^GG3
```

The walk steps through the CIGAR ops in order, and only the `M` runs consume MD:

| CIGAR | read  | ref     | MD             | reported                              |
| ----- | ----- | ------- | -------------- | ------------------------------------- |
| `5M`  | 0–4   | 100–104 | `3A`, 1 of `5` | `X` at 103, `G` for reference `A`     |
| `1I`  | 5     | —       | —              | `I` at 105, `clipLength` 1, bases `C` |
| `4M`  | 6–9   | 105–108 | rest of `5`    | nothing                               |
| `2D`  | —     | 109–110 | `^GG`          | `D` at 109, `length` 2                |
| `3M`  | 10–12 | 111–113 | `3`            | nothing                               |

MD's `3A5` spans both `M` runs (9 aligned bases) uninterrupted, because the
insertion between them consumes no reference.

## How the walk resolves substitutions

`forEachMismatchNumeric` in [`src/mismatches.ts`](../src/mismatches.ts) makes
one pass over the packed CIGAR, tracking a read offset and a reference offset.
Indels, skips and clips come directly from the CIGAR. Substitutions come from
the first of these that is available:

1. **the `MD` tag** — cheapest, and what the aligner asserted
2. **reference bases** — `opts.ref`, or whatever `setReference` bound; compared
   two bases per byte against the read's 4-bit packed `SEQ`
3. **`X` CIGAR ops** — these give the position, but name the reference base only
   if 1 or 2 also supplied it (`refBaseCode` is 0 otherwise)

With none of them, the walk reports every indel and clip and no substitutions,
because the record does not contain the substitution positions.

## Decoding mistakes the walk avoids

- `M` does not mean match, and a CIGAR with `=`/`X` ops marks substitutions that
  the walk would otherwise look up in `MD`.
- MD counts reference bases; the CIGAR counts both, so their offsets diverge at
  every insertion and clip.
- The walk has to step over a deletion's `^GG` rather than read it as matches;
  otherwise every later position in the read maps to the wrong part of the tag.
- Most aligners omit MD entirely, so the walk needs the reference bases instead.
- A read with `SEQ` of `*` has no bases at all, but its `X` ops still consume
  reference and still have to advance the walk.

Every one of these has been a bug in a downstream consumer.
