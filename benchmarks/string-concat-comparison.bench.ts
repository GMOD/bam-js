import { bench, describe } from 'vitest'
import BamFile from '../esm/bamFile.js'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')
const CIGAR_DECODER = 'MIDNSHP=X???????'.split('')

// Old implementations (array + join)
function decodeSeqOld(
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

// New implementation (string concat)
function decodeSeqNew(
  byteArray: Uint8Array,
  offset: number,
  len: number,
): string {
  const fullBytes = len >> 1
  let result = ''

  for (let j = 0; j < fullBytes; j++) {
    const sb = byteArray[offset + j]!
    result += SEQRET_DECODER[(sb & 0xf0) >> 4]! + SEQRET_DECODER[sb & 0x0f]!
  }

  if ((len & 1) !== 0) {
    const sb = byteArray[offset + fullBytes]!
    result += SEQRET_DECODER[(sb & 0xf0) >> 4]!
  }

  return result
}

// Old CIGAR implementation
function decodeCigarOld(
  view: DataView,
  offset: number,
  numOps: number,
): { CIGAR: string; lref: number } {
  const CIGAR = new Array(numOps)
  let lref = 0
  let idx = 0

  for (let c = 0; c < numOps; ++c) {
    const cigop = view.getInt32(offset + c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    CIGAR[idx++] = lop + op

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { CIGAR: CIGAR.join(''), lref }
}

// New CIGAR implementation
function decodeCigarNew(
  view: DataView,
  offset: number,
  numOps: number,
): { CIGAR: string; lref: number } {
  let CIGAR = ''
  let lref = 0

  for (let c = 0; c < numOps; ++c) {
    const cigop = view.getInt32(offset + c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    CIGAR += lop + op

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { CIGAR, lref }
}

// Create test data
function createSeqData(len: number): Uint8Array {
  const bytes = new Uint8Array((len + 1) >> 1)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytes
}

function createCigarData(numOps: number): DataView {
  const buffer = new Uint8Array(numOps * 4)
  const view = new DataView(buffer.buffer)
  for (let i = 0; i < numOps; i++) {
    const length = Math.floor(Math.random() * 100) + 1
    const op = Math.floor(Math.random() * 9)
    view.setInt32(i * 4, (length << 4) | op, true)
  }
  return view
}

describe('Sequence Decoding Comparison - Short (100bp)', () => {
  const data = createSeqData(100)

  bench(
    'old (array + join)',
    () => {
      decodeSeqOld(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'new (string concat)',
    () => {
      decodeSeqNew(data, 0, 100)
    },
    { iterations: 10000 },
  )
})

describe('Sequence Decoding Comparison - Long (10,000bp)', () => {
  const data = createSeqData(10000)

  bench(
    'old (array + join)',
    () => {
      decodeSeqOld(data, 0, 10000)
    },
    { iterations: 5000 },
  )

  bench(
    'new (string concat)',
    () => {
      decodeSeqNew(data, 0, 10000)
    },
    { iterations: 5000 },
  )
})

describe('CIGAR Decoding Comparison - Typical (20 ops)', () => {
  const data = createCigarData(20)

  bench(
    'old (array + join)',
    () => {
      decodeCigarOld(data, 0, 20)
    },
    { iterations: 10000 },
  )

  bench(
    'new (string concat)',
    () => {
      decodeCigarNew(data, 0, 20)
    },
    { iterations: 10000 },
  )
})

describe('CIGAR Decoding Comparison - Complex (100 ops)', () => {
  const data = createCigarData(100)

  bench(
    'old (array + join)',
    () => {
      decodeCigarOld(data, 0, 100)
    },
    { iterations: 10000 },
  )

  bench(
    'new (string concat)',
    () => {
      decodeCigarNew(data, 0, 100)
    },
    { iterations: 10000 },
  )
})

describe('End-to-End: Real BAM file (long reads)', () => {
  const bam = new BamFile({
    bamPath: './test/data/out.bam',
    baiPath: './test/data/out.bam.bai',
  })

  bench(
    'query 1:1-100000 and access all fields',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 100000)
      for (const record of records) {
        const _start = record.start
        const _end = record.end
        const _strand = record.strand
        const _name = record.name
        const _cigar = record.CIGAR
        const _seq = record.seq
        const _qual = record.qual
        const _tags = record.tags
      }
    },
    { iterations: 50 },
  )

  bench(
    'query 1:1-100000 and access seq + cigar only',
    async () => {
      await bam.getHeader()
      const records = await bam.getRecordsForRange('1', 1, 100000)
      for (const record of records) {
        const _cigar = record.CIGAR
        const _seq = record.seq
      }
    },
    { iterations: 50 },
  )
})
