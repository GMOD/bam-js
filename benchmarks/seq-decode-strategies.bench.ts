import { bench, describe } from 'vitest'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')

// Create test data - simulate packed BAM sequence data
function createTestData(length: number): Uint8Array {
  const bytes = new Uint8Array((length + 1) >> 1)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

// Current implementation
function decodeSeqCurrent(byteArray: Uint8Array, len: number): string {
  const buf = new Array(len)
  let i = 0
  const fullBytes = len >> 1

  for (let j = 0; j < fullBytes; ++j) {
    const sb = byteArray[j]!
    buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    buf[i++] = SEQRET_DECODER[sb & 0x0f]
  }

  if (i < len) {
    const sb = byteArray[fullBytes]!
    buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
  }

  return buf.join('')
}

// String concatenation (might be faster for modern JS engines)
function decodeSeqConcat(byteArray: Uint8Array, len: number): string {
  let result = ''
  const fullBytes = len >> 1

  for (let j = 0; j < fullBytes; j++) {
    const sb = byteArray[j]!
    result += SEQRET_DECODER[(sb & 0xf0) >> 4]! + SEQRET_DECODER[sb & 0x0f]!
  }

  if ((len & 1) !== 0) {
    const sb = byteArray[fullBytes]!
    result += SEQRET_DECODER[(sb & 0xf0) >> 4]!
  }

  return result
}

// Chunked approach for large sequences
function decodeSeqChunked(byteArray: Uint8Array, len: number): string {
  const chunkSize = 1024
  let result = ''

  for (let chunkStart = 0; chunkStart < len; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, len)
    const chunkLen = chunkEnd - chunkStart
    const chunk = new Array(chunkLen)

    const chunkFullBytes = chunkLen >> 1
    const byteOffset = chunkStart >> 1

    let i = 0
    for (let j = 0; j < chunkFullBytes; j++) {
      const sb = byteArray[byteOffset + j]!
      chunk[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
      chunk[i++] = SEQRET_DECODER[sb & 0x0f]
    }

    if (i < chunkLen) {
      const sb = byteArray[byteOffset + chunkFullBytes]!
      chunk[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
    }

    result += chunk.join('')
  }

  return result
}

// Using Uint8Array instead of Array (avoid boxing)
function decodeSeqTyped(byteArray: Uint8Array, len: number): string {
  const codes = new Uint8Array(len)
  const fullBytes = len >> 1

  let i = 0
  for (let j = 0; j < fullBytes; j++) {
    const sb = byteArray[j]!
    codes[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]!.charCodeAt(0)
    codes[i++] = SEQRET_DECODER[sb & 0x0f]!.charCodeAt(0)
  }

  if (i < len) {
    const sb = byteArray[fullBytes]!
    codes[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]!.charCodeAt(0)
  }

  return String.fromCharCode(...codes)
}

// Pre-compute lookup table with char codes
const SEQRET_CODES = new Uint8Array(16)
for (let i = 0; i < 16; i++) {
  SEQRET_CODES[i] = SEQRET_DECODER[i]!.charCodeAt(0)
}

function decodeSeqPrecomputed(byteArray: Uint8Array, len: number): string {
  const codes = new Uint8Array(len)
  const fullBytes = len >> 1

  let i = 0
  for (let j = 0; j < fullBytes; j++) {
    const sb = byteArray[j]!
    codes[i++] = SEQRET_CODES[(sb & 0xf0) >> 4]!
    codes[i++] = SEQRET_CODES[sb & 0x0f]!
  }

  if (i < len) {
    const sb = byteArray[fullBytes]!
    codes[i] = SEQRET_CODES[(sb & 0xf0) >> 4]!
  }

  return String.fromCharCode(...codes)
}

describe('Sequence Decoding - Short reads (100bp)', () => {
  const shortSeq = createTestData(100)

  bench('current (array + join)', () => {
    decodeSeqCurrent(shortSeq, 100)
  })

  bench('string concat', () => {
    decodeSeqConcat(shortSeq, 100)
  })

  bench('chunked', () => {
    decodeSeqChunked(shortSeq, 100)
  })

  bench('typed array + fromCharCode', () => {
    decodeSeqTyped(shortSeq, 100)
  })

  bench('precomputed codes', () => {
    decodeSeqPrecomputed(shortSeq, 100)
  })
})

describe('Sequence Decoding - Long reads (10,000bp)', () => {
  const longSeq = createTestData(10000)

  bench('current (array + join)', () => {
    decodeSeqCurrent(longSeq, 10000)
  })

  bench('string concat', () => {
    decodeSeqConcat(longSeq, 10000)
  })

  bench('chunked', () => {
    decodeSeqChunked(longSeq, 10000)
  })

  bench('typed array + fromCharCode', () => {
    decodeSeqTyped(longSeq, 10000)
  })

  bench('precomputed codes', () => {
    decodeSeqPrecomputed(longSeq, 10000)
  })
})

describe('Sequence Decoding - Very long reads (50,000bp)', () => {
  const veryLongSeq = createTestData(50000)

  bench('current (array + join)', () => {
    decodeSeqCurrent(veryLongSeq, 50000)
  })

  bench('string concat', () => {
    decodeSeqConcat(veryLongSeq, 50000)
  })

  bench('chunked', () => {
    decodeSeqChunked(veryLongSeq, 50000)
  })

  bench('typed array + fromCharCode', () => {
    decodeSeqTyped(veryLongSeq, 50000)
  })

  bench('precomputed codes', () => {
    decodeSeqPrecomputed(veryLongSeq, 50000)
  })
})
