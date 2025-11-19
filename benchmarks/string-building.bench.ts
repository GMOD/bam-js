import { bench, describe } from 'vitest'

describe('String Building Approaches', () => {
  const bytes = new Uint8Array([72, 69, 76, 76, 79, 95, 87, 79, 82, 76, 68]) // "HELLO_WORLD"

  bench('character-by-character (current)', () => {
    for (let run = 0; run < 10000; run++) {
      let str = ''
      for (let i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i]!)
      }
    }
  })

  bench('TextDecoder latin1', () => {
    const decoder = new TextDecoder('latin1')
    for (let run = 0; run < 10000; run++) {
      const str = decoder.decode(bytes)
    }
  })

  bench('TextDecoder utf8', () => {
    const decoder = new TextDecoder('utf8')
    for (let run = 0; run < 10000; run++) {
      const str = decoder.decode(bytes)
    }
  })

  bench('array join', () => {
    for (let run = 0; run < 10000; run++) {
      const arr = []
      for (let i = 0; i < bytes.length; i++) {
        arr.push(String.fromCharCode(bytes[i]!))
      }
      const str = arr.join('')
    }
  })
})

describe('String Building - Very Short (read names, typically 5-20 chars)', () => {
  const bytes = new Uint8Array([72, 69, 76, 76, 79]) // "HELLO"

  bench('character-by-character (current)', () => {
    for (let run = 0; run < 10000; run++) {
      let str = ''
      for (let i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i]!)
      }
    }
  })

  bench('TextDecoder latin1', () => {
    const decoder = new TextDecoder('latin1')
    for (let run = 0; run < 10000; run++) {
      const str = decoder.decode(bytes)
    }
  })

  bench('array join', () => {
    for (let run = 0; run < 10000; run++) {
      const arr = []
      for (let i = 0; i < bytes.length; i++) {
        arr.push(String.fromCharCode(bytes[i]!))
      }
      const str = arr.join('')
    }
  })
})

describe('String Building - Long (sequences, 50-500 chars)', () => {
  const bytes = new Uint8Array(200).fill(65) // 200 'A's

  bench('character-by-character', () => {
    for (let run = 0; run < 1000; run++) {
      let str = ''
      for (let i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i]!)
      }
    }
  })

  bench('TextDecoder latin1', () => {
    const decoder = new TextDecoder('latin1')
    for (let run = 0; run < 1000; run++) {
      const str = decoder.decode(bytes)
    }
  })

  bench('array join', () => {
    for (let run = 0; run < 1000; run++) {
      const arr = []
      for (let i = 0; i < bytes.length; i++) {
        arr.push(String.fromCharCode(bytes[i]!))
      }
      const str = arr.join('')
    }
  })
})
