import { bench, describe } from 'vitest'

describe('Tags Parser Optimization', () => {
  // Simulate tag parsing with if/else chain vs switch
  const types = ['A', 'i', 'I', 'c', 'C', 's', 'S', 'f', 'Z']
  const randomTypes = Array.from(
    { length: 1000 },
    () => types[Math.floor(Math.random() * types.length)],
  )

  bench('if/else chain (current)', () => {
    let count = 0
    for (const type of randomTypes) {
      if (type === 'A') {
        count += 1
      } else if (type === 'i') {
        count += 4
      } else if (type === 'I') {
        count += 4
      } else if (type === 'c') {
        count += 1
      } else if (type === 'C') {
        count += 1
      } else if (type === 's') {
        count += 2
      } else if (type === 'S') {
        count += 2
      } else if (type === 'f') {
        count += 4
      } else if (type === 'Z' || type === 'H') {
        count += 10
      }
    }
  })

  bench('switch statement', () => {
    let count = 0
    for (const type of randomTypes) {
      switch (type) {
        case 'A':
          count += 1
          break
        case 'i':
          count += 4
          break
        case 'I':
          count += 4
          break
        case 'c':
          count += 1
          break
        case 'C':
          count += 1
          break
        case 's':
          count += 2
          break
        case 'S':
          count += 2
          break
        case 'f':
          count += 4
          break
        case 'Z':
        case 'H':
          count += 10
          break
      }
    }
  })
})

describe('Tag Name Creation', () => {
  const bytes = new Uint8Array([65, 66]) // "AB"

  bench('String.fromCharCode per tag (current)', () => {
    for (let i = 0; i < 10000; i++) {
      const tag = String.fromCharCode(bytes[0]!, bytes[1]!)
    }
  })

  bench('pre-create lookup table', () => {
    // This would be done once at module level
    const tagCache = new Map<number, string>()

    for (let i = 0; i < 10000; i++) {
      const key = (bytes[0]! << 8) | bytes[1]!
      let tag = tagCache.get(key)
      if (!tag) {
        tag = String.fromCharCode(bytes[0]!, bytes[1]!)
        tagCache.set(key, tag)
      }
    }
  })

  bench('direct string concat', () => {
    for (let i = 0; i < 10000; i++) {
      const tag =
        String.fromCharCode(bytes[0]!) + String.fromCharCode(bytes[1]!)
    }
  })
})
