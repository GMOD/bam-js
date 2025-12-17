import { bench, describe } from 'vitest'

// CIGAR operation constants
const CIGAR_INS = 1
const CIGAR_SOFT_CLIP = 4
const CIGAR_HARD_CLIP = 5

const CIGAR_SKIP_MASK =
  (1 << CIGAR_INS) | (1 << CIGAR_SOFT_CLIP) | (1 << CIGAR_HARD_CLIP)

const CIGAR_CONSUMES_REF_MASK = 0x1cd

const CIGAR_CONSUMES_REF_TABLE = new Int32Array([
  1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
])

// Generate test CIGAR data (mix of ops that do/don't consume ref)
function generateCigarData(numOps: number, aligned: boolean) {
  const padding = aligned ? 0 : 1
  const buffer = new ArrayBuffer(padding + numOps * 4 + 4)
  const view = new DataView(buffer)

  for (let i = 0; i < numOps; i++) {
    // Random op (0-8), random length (1-1000)
    const op = Math.floor(Math.random() * 9)
    const len = Math.floor(Math.random() * 1000) + 1
    const cigop = (len << 4) | op
    view.setInt32(padding + i * 4, cigop, true)
  }

  return {
    byteArray: new Uint8Array(buffer, padding),
    dataView: new DataView(buffer, padding),
    buffer,
    offset: padding,
    numOps,
  }
}

// Approach 1: Original - DataView.getInt32 + branch
function originalApproach(
  dataView: DataView,
  numOps: number,
): { lref: number; cigar: number[] } {
  const cigarArray: number[] = new Array(numOps)
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const cigop = dataView.getInt32(c * 4, true) | 0
    cigarArray[c] = cigop
    const op = (cigop & 0xf) | 0
    if (!((1 << op) & CIGAR_SKIP_MASK)) {
      lref = (lref + (cigop >> 4)) | 0
    }
  }
  return { lref, cigar: cigarArray }
}

// Approach 2: Direct byte access + bitmask
function directBytesBitmask(
  byteArray: Uint8Array,
  numOps: number,
): { lref: number; cigar: number[] } {
  const cigarArray: number[] = new Array(numOps)
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const offset = c * 4
    const cigop =
      (byteArray[offset]! |
        (byteArray[offset + 1]! << 8) |
        (byteArray[offset + 2]! << 16) |
        (byteArray[offset + 3]! << 24)) |
      0
    cigarArray[c] = cigop
    lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
  }
  return { lref, cigar: cigarArray }
}

// Approach 3: Direct byte access + lookup table
function directBytesLookup(
  byteArray: Uint8Array,
  numOps: number,
): { lref: number; cigar: number[] } {
  const cigarArray: number[] = new Array(numOps)
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const offset = c * 4
    const cigop =
      (byteArray[offset]! |
        (byteArray[offset + 1]! << 8) |
        (byteArray[offset + 2]! << 16) |
        (byteArray[offset + 3]! << 24)) |
      0
    cigarArray[c] = cigop
    lref += (cigop >> 4) * CIGAR_CONSUMES_REF_TABLE[cigop & 0xf]!
  }
  return { lref, cigar: cigarArray }
}

// Approach 4: DataView + bitmask (hybrid)
function dataViewBitmask(
  dataView: DataView,
  numOps: number,
): { lref: number; cigar: number[] } {
  const cigarArray: number[] = new Array(numOps)
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const cigop = dataView.getInt32(c * 4, true) | 0
    cigarArray[c] = cigop
    lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
  }
  return { lref, cigar: cigarArray }
}

// Approach 5: Uint32Array view (only works for aligned data)
function uint32ViewBitmask(
  buffer: ArrayBuffer,
  offset: number,
  numOps: number,
): { lref: number; cigar: Uint32Array } {
  const cigarView = new Uint32Array(buffer, offset, numOps)
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const cigop = cigarView[c]!
    lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
  }
  return { lref, cigar: cigarView }
}

// Approach 6: Uint32Array slice+copy (works for unaligned)
function uint32SliceCopy(
  byteArray: Uint8Array,
  numOps: number,
): { lref: number; cigar: Uint32Array } {
  const copy = byteArray.slice(0, numOps * 4)
  const cigarView = new Uint32Array(
    copy.buffer,
    copy.byteOffset,
    numOps,
  )
  let lref = 0
  for (let c = 0; c < numOps; ++c) {
    const cigop = cigarView[c]!
    lref += (cigop >> 4) * ((CIGAR_CONSUMES_REF_MASK >> (cigop & 0xf)) & 1)
  }
  return { lref, cigar: cigarView }
}

function benchCigarSize(name: string, numOps: number, iterations: number) {
  const alignedData = generateCigarData(numOps, true)
  const unalignedData = generateCigarData(numOps, false)

  describe(`${name} - aligned`, () => {
    bench(
      'original (DataView + branch)',
      () => {
        originalApproach(alignedData.dataView, numOps)
      },
      { iterations },
    )

    bench(
      'DataView + bitmask',
      () => {
        dataViewBitmask(alignedData.dataView, numOps)
      },
      { iterations },
    )

    bench(
      'direct bytes + bitmask',
      () => {
        directBytesBitmask(alignedData.byteArray, numOps)
      },
      { iterations },
    )

    bench(
      'direct bytes + lookup table',
      () => {
        directBytesLookup(alignedData.byteArray, numOps)
      },
      { iterations },
    )

    bench(
      'Uint32Array view + bitmask',
      () => {
        uint32ViewBitmask(alignedData.buffer, alignedData.offset, numOps)
      },
      { iterations },
    )
  })

  describe(`${name} - unaligned`, () => {
    bench(
      'original (DataView + branch)',
      () => {
        originalApproach(unalignedData.dataView, numOps)
      },
      { iterations },
    )

    bench(
      'DataView + bitmask',
      () => {
        dataViewBitmask(unalignedData.dataView, numOps)
      },
      { iterations },
    )

    bench(
      'direct bytes + bitmask',
      () => {
        directBytesBitmask(unalignedData.byteArray, numOps)
      },
      { iterations },
    )

    bench(
      'direct bytes + lookup table',
      () => {
        directBytesLookup(unalignedData.byteArray, numOps)
      },
      { iterations },
    )

    bench(
      'Uint32Array slice+copy + bitmask',
      () => {
        uint32SliceCopy(unalignedData.byteArray, numOps)
      },
      { iterations },
    )
  })
}

// Test various CIGAR sizes
benchCigarSize('tiny (3 ops)', 3, 50000)
benchCigarSize('small (10 ops)', 10, 50000)
benchCigarSize('medium (50 ops)', 50, 20000)
benchCigarSize('large (200 ops)', 200, 10000)
benchCigarSize('huge (1000 ops)', 1000, 2000)
benchCigarSize('extreme (10000 ops)', 10000, 500)
