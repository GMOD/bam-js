import { bench, describe } from 'vitest'

// CIGAR operation codes from BAM spec
const CIGAR_MATCH = 0
const CIGAR_INS = 1
const CIGAR_DEL = 2
const CIGAR_REF_SKIP = 3
const CIGAR_SOFT_CLIP = 4
const CIGAR_HARD_CLIP = 5

// ops that don't consume reference: INS, SOFT_CLIP, HARD_CLIP
const CIGAR_SKIP_MASK =
  (1 << CIGAR_INS) | (1 << CIGAR_SOFT_CLIP) | (1 << CIGAR_HARD_CLIP)

// ops that DO consume reference (for fast path check)
const CIGAR_CONSUMES_REF_MASK = ~CIGAR_SKIP_MASK & 0xf

// Helper to pack a CIGAR op: length in upper 28 bits, op in lower 4 bits
function packCigarOp(length: number, op: number) {
  return (length << 4) | op
}

// Generate test CIGAR arrays
function generateSimpleMatchCigar(length: number) {
  return new Uint32Array([packCigarOp(length, CIGAR_MATCH)])
}

function generateTypicalShortReadCigar() {
  // Typical short read: 5S + 90M + 5S (100bp read with soft clips)
  return new Uint32Array([
    packCigarOp(5, CIGAR_SOFT_CLIP),
    packCigarOp(90, CIGAR_MATCH),
    packCigarOp(5, CIGAR_SOFT_CLIP),
  ])
}

function generateComplexCigar() {
  // More complex: 2S + 30M + 2I + 40M + 3D + 25M + 1S
  return new Uint32Array([
    packCigarOp(2, CIGAR_SOFT_CLIP),
    packCigarOp(30, CIGAR_MATCH),
    packCigarOp(2, CIGAR_INS),
    packCigarOp(40, CIGAR_MATCH),
    packCigarOp(3, CIGAR_DEL),
    packCigarOp(25, CIGAR_MATCH),
    packCigarOp(1, CIGAR_SOFT_CLIP),
  ])
}

function generateLongReadCigar(numOps: number) {
  // Long read with many operations (typical nanopore)
  const ops = new Uint32Array(numOps)
  for (let i = 0; i < numOps; i++) {
    // Alternate between M, I, D with varying lengths
    const opType = i % 3 === 0 ? CIGAR_MATCH : i % 3 === 1 ? CIGAR_INS : CIGAR_DEL
    ops[i] = packCigarOp(10 + (i % 20), opType)
  }
  return ops
}

// Current implementation (baseline) - matches src/record.ts which caches numCigarOps
function computeLengthOnRefCurrent(cigarView: Uint32Array) {
  const numCigarOps = cigarView.length
  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }
  return lref
}

// Fast path for single-op CIGAR (e.g., "100M")
function computeLengthOnRefFastPath(cigarView: Uint32Array) {
  const len = cigarView.length
  if (len === 1) {
    const cigop = cigarView[0]!
    const op = cigop & 0xf
    // Most single-op CIGARs are M (0), = (7), or X (8) which all consume ref
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      return cigop >> 4
    }
    return 0
  }

  let lref = 0
  for (let c = 0; c < len; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }
  return lref
}

// Alternative: switch statement approach
function computeLengthOnRefSwitch(cigarView: Uint32Array) {
  const numCigarOps = cigarView.length
  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    switch (op) {
      case CIGAR_INS:
      case CIGAR_SOFT_CLIP:
      case CIGAR_HARD_CLIP:
        break
      default:
        lref += cigop >> 4
    }
  }
  return lref
}

// Alternative: unrolled loop for small CIGARs
function computeLengthOnRefUnrolled(cigarView: Uint32Array) {
  const len = cigarView.length
  let lref = 0

  if (len === 1) {
    const cigop = cigarView[0]!
    const op = cigop & 0xf
    return ((1 << op) & CIGAR_SKIP_MASK) ? 0 : cigop >> 4
  }

  if (len === 2) {
    const cigop0 = cigarView[0]!
    const op0 = cigop0 & 0xf
    if (!((1 << op0) & CIGAR_SKIP_MASK)) {
      lref += cigop0 >> 4
    }
    const cigop1 = cigarView[1]!
    const op1 = cigop1 & 0xf
    if (!((1 << op1) & CIGAR_SKIP_MASK)) {
      lref += cigop1 >> 4
    }
    return lref
  }

  if (len === 3) {
    const cigop0 = cigarView[0]!
    const op0 = cigop0 & 0xf
    if (!((1 << op0) & CIGAR_SKIP_MASK)) {
      lref += cigop0 >> 4
    }
    const cigop1 = cigarView[1]!
    const op1 = cigop1 & 0xf
    if (!((1 << op1) & CIGAR_SKIP_MASK)) {
      lref += cigop1 >> 4
    }
    const cigop2 = cigarView[2]!
    const op2 = cigop2 & 0xf
    if (!((1 << op2) & CIGAR_SKIP_MASK)) {
      lref += cigop2 >> 4
    }
    return lref
  }

  for (let c = 0; c < len; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }
  return lref
}

// Alternative: lookup table approach
const CONSUMES_REF = new Uint8Array(16)
CONSUMES_REF[CIGAR_MATCH] = 1
CONSUMES_REF[CIGAR_DEL] = 1
CONSUMES_REF[CIGAR_REF_SKIP] = 1
CONSUMES_REF[6] = 1 // PAD
CONSUMES_REF[7] = 1 // EQUAL
CONSUMES_REF[8] = 1 // DIFF

function computeLengthOnRefLookup(cigarView: Uint32Array) {
  const numCigarOps = cigarView.length
  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    if (CONSUMES_REF[cigop & 0xf]) {
      lref += cigop >> 4
    }
  }
  return lref
}

// Alternative: lookup table with fast path
function computeLengthOnRefLookupFastPath(cigarView: Uint32Array) {
  const len = cigarView.length
  if (len === 1) {
    const cigop = cigarView[0]!
    return CONSUMES_REF[cigop & 0xf] ? cigop >> 4 : 0
  }

  let lref = 0
  for (let c = 0; c < len; ++c) {
    const cigop = cigarView[c]!
    if (CONSUMES_REF[cigop & 0xf]) {
      lref += cigop >> 4
    }
  }
  return lref
}

// Benchmark configurations
const simpleMatch100 = generateSimpleMatchCigar(100)
const simpleMatch150 = generateSimpleMatchCigar(150)
const typicalShortRead = generateTypicalShortReadCigar()
const complexCigar = generateComplexCigar()
const longReadCigar50 = generateLongReadCigar(50)
const longReadCigar200 = generateLongReadCigar(200)
const longReadCigar10000 = generateLongReadCigar(10000)

describe('Simple CIGAR (100M)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(simpleMatch100)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(simpleMatch100)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(simpleMatch100)
  })
  bench('unrolled', () => {
    computeLengthOnRefUnrolled(simpleMatch100)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(simpleMatch100)
  })
  bench('lookupFastPath', () => {
    computeLengthOnRefLookupFastPath(simpleMatch100)
  })
})

describe('Simple CIGAR (150M)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(simpleMatch150)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(simpleMatch150)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(simpleMatch150)
  })
  bench('lookupFastPath', () => {
    computeLengthOnRefLookupFastPath(simpleMatch150)
  })
})

describe('Typical short read (5S+90M+5S)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(typicalShortRead)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(typicalShortRead)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(typicalShortRead)
  })
  bench('unrolled', () => {
    computeLengthOnRefUnrolled(typicalShortRead)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(typicalShortRead)
  })
  bench('lookupFastPath', () => {
    computeLengthOnRefLookupFastPath(typicalShortRead)
  })
})

describe('Complex CIGAR (7 ops)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(complexCigar)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(complexCigar)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(complexCigar)
  })
  bench('unrolled', () => {
    computeLengthOnRefUnrolled(complexCigar)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(complexCigar)
  })
  bench('lookupFastPath', () => {
    computeLengthOnRefLookupFastPath(complexCigar)
  })
})

describe('Long read CIGAR (50 ops)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(longReadCigar50)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(longReadCigar50)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(longReadCigar50)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(longReadCigar50)
  })
})

describe('Long read CIGAR (200 ops)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(longReadCigar200)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(longReadCigar200)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(longReadCigar200)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(longReadCigar200)
  })
})

describe('Long read CIGAR (10000 ops)', () => {
  bench('current', () => {
    computeLengthOnRefCurrent(longReadCigar10000)
  })
  bench('fastPath', () => {
    computeLengthOnRefFastPath(longReadCigar10000)
  })
  bench('switch', () => {
    computeLengthOnRefSwitch(longReadCigar10000)
  })
  bench('lookup', () => {
    computeLengthOnRefLookup(longReadCigar10000)
  })
})
