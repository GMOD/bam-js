import { bench, describe } from 'vitest'

const SEQRET_DECODER = '=ACMGRSVTWYHKDBN'.split('')

describe('Sequence Decoding Optimization', () => {
  // Simulate typical sequence data
  const seqBytes = new Uint8Array(50) // ~100bp read
  for (let i = 0; i < seqBytes.length; i++) {
    seqBytes[i] = Math.floor(Math.random() * 256)
  }
  const seqLength = 100

  bench('current approach (push)', () => {
    for (let run = 0; run < 1000; run++) {
      const buf = []
      let i = 0
      for (let j = 0; j < seqBytes.length; ++j) {
        const sb = seqBytes[j]!
        buf.push(SEQRET_DECODER[(sb & 0xf0) >> 4])
        if (++i < seqLength) {
          buf.push(SEQRET_DECODER[sb & 0x0f])
          i++
        }
      }
      const seq = buf.join('')
    }
  })

  bench('optimized (pre-allocate array)', () => {
    for (let run = 0; run < 1000; run++) {
      const buf = new Array(seqLength)
      let i = 0
      for (let j = 0; j < seqBytes.length; ++j) {
        const sb = seqBytes[j]!
        buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
        if (i < seqLength) {
          buf[i++] = SEQRET_DECODER[sb & 0x0f]
        }
      }
      const seq = buf.join('')
    }
  })

  bench('optimized v2 (unrolled, no if in loop)', () => {
    for (let run = 0; run < 1000; run++) {
      const buf = new Array(seqLength)
      let i = 0
      const fullBytes = (seqLength - 1) >> 1

      // Process full bytes (each gives 2 bases)
      for (let j = 0; j < fullBytes; ++j) {
        const sb = seqBytes[j]!
        buf[i++] = SEQRET_DECODER[(sb & 0xf0) >> 4]
        buf[i++] = SEQRET_DECODER[sb & 0x0f]
      }

      // Handle the last byte if seqLength is odd
      if (i < seqLength) {
        const sb = seqBytes[fullBytes]!
        buf[i] = SEQRET_DECODER[(sb & 0xf0) >> 4]
      }

      const seq = buf.join('')
    }
  })
})
