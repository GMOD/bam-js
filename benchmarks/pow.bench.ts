import { readFileSync } from 'fs'
import { bench, describe } from 'vitest'

import { pow as pow1 } from '../dist_branch1/index.js'
import { pow as pow2 } from '../dist_branch2/index.js'

const branch1Name = readFileSync('dist_branch1/branchname.txt', 'utf8').trim()
const branch2Name = readFileSync('dist_branch2/branchname.txt', 'utf8').trim()

function benchPow({
  n,
  exp,
  iterations,
  warmupIterations,
}: {
  n: number
  exp: number
  iterations?: number
  warmupIterations?: number
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
  n: 2,
  exp: 10,
  warmupIterations: 100,
  iterations: 1000,
})
