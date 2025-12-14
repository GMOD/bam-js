import { bench, describe } from 'vitest'

const CIGAR_INS = 1
const CIGAR_SOFT_CLIP = 4
const CIGAR_HARD_CLIP = 5

const CIGAR_SKIP_MASK =
  (1 << CIGAR_INS) | (1 << CIGAR_SOFT_CLIP) | (1 << CIGAR_HARD_CLIP)

function packCigarOp(length: number, op: number) {
  return (length << 4) | op
}

// Simulate BAM record byte layout with CIGAR data embedded
function createMockByteArray(cigarOps: number[], aligned: boolean) {
  // Simulate: some header bytes + CIGAR data
  // We'll put some padding to test aligned vs unaligned scenarios
  const headerSize = aligned ? 36 : 37 // 36 is divisible by 4, 37 is not
  const cigarBytes = cigarOps.length * 4
  const totalSize = headerSize + cigarBytes + 100 // extra space for realism

  const buffer = new ArrayBuffer(totalSize)
  const byteArray = new Uint8Array(buffer)
  const dataView = new DataView(buffer)

  // Write CIGAR ops starting at headerSize
  for (let i = 0; i < cigarOps.length; i++) {
    dataView.setInt32(headerSize + i * 4, cigarOps[i]!, true)
  }

  return {
    byteArray,
    dataView,
    cigarOffset: headerSize,
    numCigarOps: cigarOps.length,
  }
}

// Current implementation: Uint32Array view/copy
function computeCigarCurrent(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  const absOffset = byteArray.byteOffset + cigarOffset
  const cigarView =
    absOffset % 4 === 0
      ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
      : new Uint32Array(
          byteArray
            .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
            .buffer,
          0,
          numCigarOps,
        )

  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  return {
    NUMERIC_CIGAR: cigarView,
    length_on_ref: lref,
  }
}

// Current + fast path for single op
function computeCigarCurrentFastPath(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  // Fast path for single-op CIGAR (e.g., "100M")
  if (numCigarOps === 1) {
    const cigop = dataView.getInt32(cigarOffset, true)
    const op = cigop & 0xf
    const lref = ((1 << op) & CIGAR_SKIP_MASK) ? 0 : cigop >> 4
    const absOffset = byteArray.byteOffset + cigarOffset
    const cigarView =
      absOffset % 4 === 0
        ? new Uint32Array(byteArray.buffer, absOffset, 1)
        : new Uint32Array([cigop])
    return {
      NUMERIC_CIGAR: cigarView,
      length_on_ref: lref,
    }
  }

  const absOffset = byteArray.byteOffset + cigarOffset
  const cigarView =
    absOffset % 4 === 0
      ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
      : new Uint32Array(
          byteArray
            .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
            .buffer,
          0,
          numCigarOps,
        )

  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  return {
    NUMERIC_CIGAR: cigarView,
    length_on_ref: lref,
  }
}

// DataView only - no Uint32Array allocation, compute length directly
function computeCigarDataViewOnly(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = dataView.getInt32(cigarOffset + c * 4, true)
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  // Still need to create the array for NUMERIC_CIGAR
  const absOffset = byteArray.byteOffset + cigarOffset
  const cigarView =
    absOffset % 4 === 0
      ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
      : new Uint32Array(
          byteArray
            .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
            .buffer,
          0,
          numCigarOps,
        )

  return {
    NUMERIC_CIGAR: cigarView,
    length_on_ref: lref,
  }
}

// DataView with fast path
function computeCigarDataViewFastPath(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  if (numCigarOps === 1) {
    const cigop = dataView.getInt32(cigarOffset, true)
    const op = cigop & 0xf
    const lref = ((1 << op) & CIGAR_SKIP_MASK) ? 0 : cigop >> 4
    const absOffset = byteArray.byteOffset + cigarOffset
    const cigarView =
      absOffset % 4 === 0
        ? new Uint32Array(byteArray.buffer, absOffset, 1)
        : new Uint32Array([cigop])
    return {
      NUMERIC_CIGAR: cigarView,
      length_on_ref: lref,
    }
  }

  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = dataView.getInt32(cigarOffset + c * 4, true)
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  const absOffset = byteArray.byteOffset + cigarOffset
  const cigarView =
    absOffset % 4 === 0
      ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
      : new Uint32Array(
          byteArray
            .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
            .buffer,
          0,
          numCigarOps,
        )

  return {
    NUMERIC_CIGAR: cigarView,
    length_on_ref: lref,
  }
}

// Lazy NUMERIC_CIGAR - return a getter instead of the array
// This tests if deferring array creation helps when only length_on_ref is needed
function computeCigarLazy(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = dataView.getInt32(cigarOffset + c * 4, true)
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  let cachedCigar: Uint32Array | undefined
  return {
    get NUMERIC_CIGAR() {
      if (cachedCigar === undefined) {
        const absOffset = byteArray.byteOffset + cigarOffset
        cachedCigar =
          absOffset % 4 === 0
            ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
            : new Uint32Array(
                byteArray
                  .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
                  .buffer,
                0,
                numCigarOps,
              )
      }
      return cachedCigar
    },
    length_on_ref: lref,
  }
}

// Plain number array instead of Uint32Array
function computeCigarPlainArray(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  const cigarArray: number[] = new Array(numCigarOps)
  let lref = 0

  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = dataView.getInt32(cigarOffset + c * 4, true)
    cigarArray[c] = cigop
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  return {
    NUMERIC_CIGAR: cigarArray,
    length_on_ref: lref,
  }
}

// Plain array with |0 to force 32-bit integer representation
function computeCigarPlainArrayInt32(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
) {
  const cigarArray: number[] = new Array(numCigarOps)
  let lref = 0

  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = dataView.getInt32(cigarOffset + c * 4, true) | 0
    cigarArray[c] = cigop
    const op = (cigop & 0xf) | 0
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref = (lref + (cigop >> 4)) | 0
    }
  }

  return {
    NUMERIC_CIGAR: cigarArray,
    length_on_ref: lref,
  }
}

// Hybrid: plain array for small, Uint32Array for large
function computeCigarHybrid(
  byteArray: Uint8Array,
  dataView: DataView,
  cigarOffset: number,
  numCigarOps: number,
  threshold: number,
) {
  if (numCigarOps <= threshold) {
    const cigarArray: number[] = new Array(numCigarOps)
    let lref = 0

    for (let c = 0; c < numCigarOps; ++c) {
      const cigop = dataView.getInt32(cigarOffset + c * 4, true)
      cigarArray[c] = cigop
      const op = cigop & 0xf
      if (!((1 << op) & CIGAR_SKIP_MASK)) {
        lref += cigop >> 4
      }
    }

    return {
      NUMERIC_CIGAR: cigarArray,
      length_on_ref: lref,
    }
  }

  const absOffset = byteArray.byteOffset + cigarOffset
  const cigarView =
    absOffset % 4 === 0
      ? new Uint32Array(byteArray.buffer, absOffset, numCigarOps)
      : new Uint32Array(
          byteArray
            .slice(cigarOffset, cigarOffset + (numCigarOps << 2))
            .buffer,
          0,
          numCigarOps,
        )

  let lref = 0
  for (let c = 0; c < numCigarOps; ++c) {
    const cigop = cigarView[c]!
    const op = cigop & 0xf
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref += cigop >> 4
    }
  }

  return {
    NUMERIC_CIGAR: cigarView,
    length_on_ref: lref,
  }
}

// Test data generators
function generateSimpleCigarOps(matchLength: number) {
  return [packCigarOp(matchLength, 0)] // 100M
}

function generateTypicalShortReadOps() {
  return [
    packCigarOp(5, CIGAR_SOFT_CLIP),
    packCigarOp(90, 0),
    packCigarOp(5, CIGAR_SOFT_CLIP),
  ]
}

function generateComplexCigarOps() {
  return [
    packCigarOp(2, CIGAR_SOFT_CLIP),
    packCigarOp(30, 0),
    packCigarOp(2, CIGAR_INS),
    packCigarOp(40, 0),
    packCigarOp(3, 2), // DEL
    packCigarOp(25, 0),
    packCigarOp(1, CIGAR_SOFT_CLIP),
  ]
}

function generateLongReadOps(numOps: number) {
  const ops: number[] = []
  for (let i = 0; i < numOps; i++) {
    const opType = i % 3 === 0 ? 0 : i % 3 === 1 ? CIGAR_INS : 2
    ops.push(packCigarOp(10 + (i % 20), opType))
  }
  return ops
}

// Create test fixtures
const simple100Aligned = createMockByteArray(generateSimpleCigarOps(100), true)
const simple100Unaligned = createMockByteArray(generateSimpleCigarOps(100), false)
const shortReadAligned = createMockByteArray(generateTypicalShortReadOps(), true)
const complexAligned = createMockByteArray(generateComplexCigarOps(), true)
const longRead50Aligned = createMockByteArray(generateLongReadOps(50), true)
const longRead50Unaligned = createMockByteArray(generateLongReadOps(50), false)
const longRead100Aligned = createMockByteArray(generateLongReadOps(100), true)
const longRead100Unaligned = createMockByteArray(generateLongReadOps(100), false)
const longRead200Aligned = createMockByteArray(generateLongReadOps(200), true)
const longRead200Unaligned = createMockByteArray(generateLongReadOps(200), false)
const longRead10000Aligned = createMockByteArray(generateLongReadOps(10000), true)
const longRead10000Unaligned = createMockByteArray(generateLongReadOps(10000), false)

// Benchmarks
describe('Simple CIGAR 100M (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = simple100Aligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArrayInt32', () => {
    computeCigarPlainArrayInt32(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
})

describe('Simple CIGAR 100M (unaligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = simple100Unaligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
})

describe('Typical short read 5S+90M+5S (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = shortReadAligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArrayInt32', () => {
    computeCigarPlainArrayInt32(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
})

describe('Complex CIGAR 7 ops (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = complexAligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
})

describe('Long read 50 ops (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead50Aligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArrayInt32', () => {
    computeCigarPlainArrayInt32(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid25', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 25)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
  bench('hybrid100', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 100)
  })
})

describe('Long read 100 ops (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead100Aligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid25', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 25)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
  bench('hybrid100', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 100)
  })
})

describe('Long read 200 ops (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead200Aligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid25', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 25)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
  bench('hybrid100', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 100)
  })
})

describe('Long read 10000 ops (aligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead10000Aligned

  bench('current', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('hybrid25', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 25)
  })
  bench('hybrid50', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 50)
  })
  bench('hybrid100', () => {
    computeCigarHybrid(byteArray, dataView, cigarOffset, numCigarOps, 100)
  })
})

// Unaligned tests - is slice+copy ever worth it?
describe('Long read 50 ops (unaligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead50Unaligned

  bench('current (slice+copy)', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
})

describe('Long read 100 ops (unaligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead100Unaligned

  bench('current (slice+copy)', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
})

describe('Long read 200 ops (unaligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead200Unaligned

  bench('current (slice+copy)', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
})

describe('Long read 10000 ops (unaligned)', () => {
  const { byteArray, dataView, cigarOffset, numCigarOps } = longRead10000Unaligned

  bench('current (slice+copy)', () => {
    computeCigarCurrent(byteArray, dataView, cigarOffset, numCigarOps)
  })
  bench('plainArray', () => {
    computeCigarPlainArray(byteArray, dataView, cigarOffset, numCigarOps)
  })
})

