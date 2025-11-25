// src/index.ts
export function pow(n: number, exp: number) {
  let total = n
  for (let i = 1; i < exp; i++) {
    n *= exp
  }
}
