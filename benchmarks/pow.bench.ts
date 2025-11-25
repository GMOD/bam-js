import { readFileSync } from 'fs'
import { bench, describe } from 'vitest'

import { pow as pow1 } from '../esm_branch1/pow.js'
import { pow as pow2 } from '../esm_branch2/pow.js'

const branch1Name = readFileSync('esm_branch1/branchname.txt', 'utf8').trim()
const branch2Name = readFileSync('esm_branch2/branchname.txt', 'utf8').trim()

function benchPow({
  n,
  exp,
  name,
  opts,
}: {
  n: number
  exp: number
  name: string
  opts: {
    iterations?: number
    warmupIterations?: number
  }
}) {
  describe(name, () => {
    bench(
      branch1Name,
      () => {
        pow1(n, exp)
      },
      opts,
    )

    bench(
      branch2Name,
      () => {
        pow2(n, exp)
      },
      opts,
    )
  })
}

benchPow({
  name: 'pow',
  n: 2,
  exp: 10,
  opts: {
    warmupIterations: 100,
    iterations: 1000000,
  },
})
