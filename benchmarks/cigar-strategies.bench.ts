import { bench, describe } from 'vitest'

const CIGAR_DECODER = 'MIDNSHP=X???????'.split('')

// Create test CIGAR data
function createCigarData(numOps: number): Uint8Array {
  const buffer = new Uint8Array(numOps * 4)
  const view = new DataView(buffer.buffer)

  for (let i = 0; i < numOps; i++) {
    const length = Math.floor(Math.random() * 100) + 1
    const op = Math.floor(Math.random() * 9) // M, I, D, N, S, H, P, =, X
    const cigop = (length << 4) | op
    view.setInt32(i * 4, cigop, true)
  }

  return buffer
}

// Current implementation
function decodeCigarCurrent(
  data: Uint8Array,
  numOps: number,
): { cigar: string; refLen: number } {
  const view = new DataView(data.buffer)
  const CIGAR = new Array(numOps)
  let lref = 0
  let idx = 0

  for (let c = 0; c < numOps; c++) {
    const cigop = view.getInt32(c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    CIGAR[idx++] = lop + op

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { cigar: CIGAR.join(''), refLen: lref }
}

// String concatenation
function decodeCigarConcat(
  data: Uint8Array,
  numOps: number,
): { cigar: string; refLen: number } {
  const view = new DataView(data.buffer)
  let cigar = ''
  let lref = 0

  for (let c = 0; c < numOps; c++) {
    const cigop = view.getInt32(c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    cigar += lop + op

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { cigar, refLen: lref }
}

// Pre-allocate string parts then join
function decodeCigarPrealloc(
  data: Uint8Array,
  numOps: number,
): { cigar: string; refLen: number } {
  const view = new DataView(data.buffer)
  const parts = new Array(numOps * 2) // length + op
  let lref = 0
  let idx = 0

  for (let c = 0; c < numOps; c++) {
    const cigop = view.getInt32(c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    parts[idx++] = lop
    parts[idx++] = op

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { cigar: parts.join(''), refLen: lref }
}

// Template literal
function decodeCigarTemplate(
  data: Uint8Array,
  numOps: number,
): { cigar: string; refLen: number } {
  const view = new DataView(data.buffer)
  const CIGAR = new Array(numOps)
  let lref = 0
  let idx = 0

  for (let c = 0; c < numOps; c++) {
    const cigop = view.getInt32(c * 4, true)
    const lop = cigop >> 4
    const op = CIGAR_DECODER[cigop & 0xf]!
    CIGAR[idx++] = `${lop}${op}`

    if (op !== 'H' && op !== 'S' && op !== 'I') {
      lref += lop
    }
  }

  return { cigar: CIGAR.join(''), refLen: lref }
}

// Switch for ref length calculation
function decodeCigarSwitch(
  data: Uint8Array,
  numOps: number,
): { cigar: string; refLen: number } {
  const view = new DataView(data.buffer)
  const CIGAR = new Array(numOps)
  let lref = 0
  let idx = 0

  for (let c = 0; c < numOps; c++) {
    const cigop = view.getInt32(c * 4, true)
    const lop = cigop >> 4
    const opCode = cigop & 0xf
    const op = CIGAR_DECODER[opCode]!
    CIGAR[idx++] = lop + op

    // Use switch for better branch prediction
    switch (opCode) {
      case 0: // M
      case 2: // D
      case 3: // N
      case 7: // =
      case 8: // X
        lref += lop
        break
    }
  }

  return { cigar: CIGAR.join(''), refLen: lref }
}

describe('CIGAR Decoding - Typical (20 ops)', () => {
  const data = createCigarData(20)

  bench('current (array + join)', () => {
    decodeCigarCurrent(data, 20)
  })

  bench('string concat', () => {
    decodeCigarConcat(data, 20)
  })

  bench('prealloc parts', () => {
    decodeCigarPrealloc(data, 20)
  })

  bench('template literal', () => {
    decodeCigarTemplate(data, 20)
  })

  bench('switch statement', () => {
    decodeCigarSwitch(data, 20)
  })
})

describe('CIGAR Decoding - Complex (100 ops)', () => {
  const data = createCigarData(100)

  bench('current (array + join)', () => {
    decodeCigarCurrent(data, 100)
  })

  bench('string concat', () => {
    decodeCigarConcat(data, 100)
  })

  bench('prealloc parts', () => {
    decodeCigarPrealloc(data, 100)
  })

  bench('template literal', () => {
    decodeCigarTemplate(data, 100)
  })

  bench('switch statement', () => {
    decodeCigarSwitch(data, 100)
  })
})
