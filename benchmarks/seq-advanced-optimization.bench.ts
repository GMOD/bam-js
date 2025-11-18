import { bench, describe } from 'vitest'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')

// Create a 256-entry lookup table that returns both characters for a byte
const BYTE_TO_CHARS = new Array(256)
for (let byte = 0; byte < 256; byte++) {
  const high = SEQRET_DECODER[(byte & 0xf0) >> 4]!
  const low = SEQRET_DECODER[byte & 0x0f]!
  BYTE_TO_CHARS[byte] = [high, low]
}

// Current implementation
function decodeSeqCurrent(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const buf = new Array(len)
  let i = 0
  const fullBytes = len >> 1

  for (let j = 0; j < fullBytes; ++j) {
    const sb = byteArray[offset + j]!
    buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb & 0x0f]
  }

  if (i < len) {
    const sb = byteArray[offset + fullBytes]!
    buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// Pre-computed two-character lookup
function decodeSeqLookupTable(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const buf = new Array(len)
  let i = 0
  const fullBytes = len >> 1

  for (let j = 0; j < fullBytes; ++j) {
    const chars = BYTE_TO_CHARS[byteArray[offset + j]!]!
    buf[i++] = chars[0]
    buf[i++] = chars[1]
  }

  if (i < len) {
    const sb = byteArray[offset + fullBytes]!
    buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// Avoid indexing overhead with local variable
function decodeSeqLocalDecoder(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const decoder = SEQRET_DECODER
  const buf = new Array(len)
  let i = 0
  const fullBytes = len >> 1

  for (let j = 0; j < fullBytes; ++j) {
    const sb = byteArray[offset + j]!
    buf[i++] = decoder[(sb & 0xf0) >> 4]
    buf[i++] = decoder[sb & 0x0f]
  }

  if (i < len) {
    const sb = byteArray[offset + fullBytes]!
    buf[i] = decoder[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// Manual loop unrolling (process 2 bytes at a time)
function decodeSeqUnrolled(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const buf = new Array(len)
  let i = 0
  const fullBytes = len >> 1
  const unrollLimit = fullBytes - (fullBytes % 2)

  // Process 2 bytes (4 chars) at a time
  for (let j = 0; j < unrollLimit; j += 2) {
    const sb1 = byteArray[offset + j]!
    buf[i++] = SEQRET_DECODER[(sb1 & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb1 & 0x0f]

    const sb2 = byteArray[offset + j + 1]!
    buf[i++] = SEQRET_DECODER[(sb2 & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb2 & 0x0f]
  }

  // Handle remaining bytes
  for (let j = unrollLimit; j < fullBytes; ++j) {
    const sb = byteArray[offset + j]!
    buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb & 0x0f]
  }

  if (i < len) {
    const sb = byteArray[offset + fullBytes]!
    buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// Use while loop instead of for loop
function decodeSeqWhileLoop(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const buf = new Array(len)
  let i = 0
  let j = 0
  const fullBytes = len >> 1

  while (j < fullBytes) {
    const sb = byteArray[offset + j]!
    buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb & 0x0f]
    j++
  }

  if (i < len) {
    const sb = byteArray[offset + fullBytes]!
    buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// Create test data
function createTestData(length: number): Uint8Array {
  const bytes = new Uint8Array((length + 1) >> 1)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

describe('Sequence Optimization - Short (100bp)', () => {
  const data = createTestData(100)

  bench(
    'current implementation',
    () => {
      decodeSeqCurrent(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'lookup table (256 entries)',
    () => {
      decodeSeqLookupTable(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'local decoder variable',
    () => {
      decodeSeqLocalDecoder(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'manual loop unrolling',
    () => {
      decodeSeqUnrolled(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'while loop',
    () => {
      decodeSeqWhileLoop(data, 0, 100)
    },
    { iterations: 10000 },
  )
})

describe('Sequence Optimization - Long (10,000bp)', () => {
  const data = createTestData(10000)

  bench(
    'current implementation',
    () => {
      decodeSeqCurrent(data, 0, 10000)
    },
    { iterations: 5000 },
  )

  bench(
    'lookup table (256 entries)',
    () => {
      decodeSeqLookupTable(data, 0, 10000)
    },
    { iterations: 5000 },
  )

  bench(
    'local decoder variable',
    () => {
      decodeSeqLocalDecoder(data, 0, 10000)
    },
    { iterations: 5000 },
  )

  bench(
    'manual loop unrolling',
    () => {
      decodeSeqUnrolled(data, 0, 10000)
    },
    { iterations: 5000 },
  )

  bench(
    'while loop',
    () => {
      decodeSeqWhileLoop(data, 0, 10000)
    },
    { iterations: 5000 },
  )
})
