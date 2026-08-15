# CIGAR, MD, and how the walk decodes mismatches

Background for `getMismatches`/`forEachMismatch`. The API reference is
[api.md](api.md#mismatches); this is what the two fields those methods read
actually say.

## CIGAR

A run-length description of how the read aligns, in order. Each op has a length
and a letter, and each consumes read bases, reference bases, or both:

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

`M` is the one to watch: it means "aligned", not "matching". Most aligners emit
`M` for both, so the CIGAR alone locates indels and clips but says nothing about
substitutions. `--eqx`-style aligners emit `=`/`X` instead, which does carry
them.

BAM stores the op count in 16 bits, so a read with more than 65535 ops keeps a
`<seqlen>S<reflen>N` placeholder in the record and the real CIGAR in a `CG` tag.
`record.CIGAR` and `record.NUMERIC_CIGAR` follow that transparently.

## MD

An aux tag that fills in what `M` left out, over the reference-consuming aligned
bases only — a number is that many matching bases, a letter is a reference base
the read differs from, and `^` plus letters is the reference bases a `D` op
deleted. Insertions, clips and `N` never appear in it.

## A worked example

A read at `chr1:100` (0-based) with:

```
CIGAR  5M1I4M2D3M
SEQ    ACGGTCAACGTTA
MD     3A5^GG3
```

Walking them together — CIGAR sets the frame, and only the `M` runs consume MD:

| CIGAR | read  | ref     | MD             | reported                              |
| ----- | ----- | ------- | -------------- | ------------------------------------- |
| `5M`  | 0–4   | 100–104 | `3A`, 1 of `5` | `X` at 103, `G` for reference `A`     |
| `1I`  | 5     | —       | —              | `I` at 105, `clipLength` 1, bases `C` |
| `4M`  | 6–9   | 105–108 | rest of `5`    | nothing                               |
| `2D`  | —     | 109–110 | `^GG`          | `D` at 109, `length` 2                |
| `3M`  | 10–12 | 111–113 | `3`            | nothing                               |

MD's `3A5` spans both `M` runs (9 aligned bases) uninterrupted, because the
insertion between them consumes no reference. That is the usual first bug.

## How the walk resolves substitutions

`forEachMismatchNumeric` in [`src/mismatches.ts`](../src/mismatches.ts) makes
one pass over the packed CIGAR, tracking a read offset and a reference offset.
Indels, skips and clips come straight off the CIGAR. Substitutions come from the
first of these that is available:

1. **the `MD` tag** — cheapest, and what the aligner asserted
2. **reference bases** — `opts.ref`, or whatever `setReference` bound; compared
   two bases per byte against the read's 4-bit packed `SEQ`
3. **`X` CIGAR ops** — these give the position, but name the reference base only
   if 1 or 2 also supplied it (`refBaseCode` is 0 otherwise)

With none of them, the walk still reports indels and clips in full and skips
substitutions entirely. Nothing in the record says where they are.

## Traps this walk exists to absorb

- `M` does not mean match, and `=`/`X` CIGARs carry substitutions the `MD` path
  would otherwise look for.
- MD counts reference bases; the CIGAR counts both, so their offsets diverge at
  every insertion and clip.
- A deletion's `^GG` payload needs stepping over, not reading as matches, or
  every later position in the read lands on the wrong part of the tag.
- Most aligners omit MD entirely, so the reference has to stand in for it.
- A read with `SEQ` of `*` has no bases at all, but its `X` ops still consume
  reference and still have to advance the walk.

Every one of these has been a bug in a downstream consumer.
