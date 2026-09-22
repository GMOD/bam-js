# hts-specs SAM conformance corpus

`test/sam/passed` from [hts-specs](https://github.com/samtools/hts-specs) at
`bf42765`, gzipped. Apache 2.0; see `LICENSE`.

`test/htsSpecsConformance.test.ts` converts each file to BAM with samtools and
checks every field and tag against `samtools view`.
