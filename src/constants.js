module.exports = {
  //  the read is paired in sequencing, no matter whether it is mapped in a pair
  BAM_FPAIRED: 1,
  //  the read is mapped in a proper pair
  BAM_FPROPER_PAIR: 2,
  //  the read itself is unmapped; conflictive with BAM_FPROPER_PAIR
  BAM_FUNMAP: 4,
  //  the mate is unmapped
  BAM_FMUNMAP: 8,
  //  the read is mapped to the reverse strand
  BAM_FREVERSE: 16,
  //  the mate is mapped to the reverse strand
  BAM_FMREVERSE: 32,
  //  this is read1
  BAM_FREAD1: 64,
  //  this is read2
  BAM_FREAD2: 128,
  //  not primary alignment
  BAM_FSECONDARY: 256,
  //  QC failure
  BAM_FQCFAIL: 512,
  //  optical or PCR duplicate
  BAM_FDUP: 1024,
  //  supplementary alignment
  BAM_FSUPPLEMENTARY: 2048,

  BAM_CMATCH: 0,
  BAM_CINS: 1,
  BAM_CDEL: 2,
  BAM_CREF_SKIP: 3,
  BAM_CSOFT_CLIP: 4,
  BAM_CHARD_CLIP: 5,
  BAM_CPAD: 6,
  BAM_CEQUAL: 7,
  BAM_CDIFF: 8,
  BAM_CBACK: 9,

  BAM_CIGAR_STR: 'MIDNSHP:XB',
  BAM_CIGAR_SHIFT: 4,
  BAM_CIGAR_MASK: 0xf,
  BAM_CIGAR_TYPE: 0x3c1a7,
}
