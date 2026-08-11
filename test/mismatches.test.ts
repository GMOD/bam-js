import { describe, expect, test } from 'vitest'

import {
  MISMATCH_DELETION,
  MISMATCH_HARD_CLIP,
  MISMATCH_INSERTION,
  MISMATCH_REF_SKIP,
  MISMATCH_SOFT_CLIP,
  MISMATCH_SUBST,
  forEachMismatchNumeric,
  packReference,
} from '../src/index.ts'

import type { Mismatch } from '../src/index.ts'

const CIGAR_OPS: Record<string, number> = {
  M: 0,
  I: 1,
  D: 2,
  N: 3,
  S: 4,
  H: 5,
  P: 6,
  '=': 7,
  X: 8,
}

function encodeCigar(cigar: string) {
  const ops: number[] = []
  const regex = /(\d+)([MIDNSHP=X])/g
  let match
  while ((match = regex.exec(cigar)) !== null) {
    ops.push((Number(match[1]) << 4) | CIGAR_OPS[match[2]!]!)
  }
  return new Uint32Array(ops)
}

// SEQ as BAM stores it: two 4-bit base codes per byte
function encodeSeq(seq: string) {
  const out = new Uint8Array((seq.length + 1) >> 1)
  for (let i = 0; i < seq.length; i++) {
    const nibble = '=ACMGRSVTWYHKDBN'.indexOf(seq[i]!.toUpperCase())
    if (i & 1) {
      out[i >> 1]! |= nibble
    } else {
      out[i >> 1] = nibble << 4
    }
  }
  return out
}

const encodeMD = (md: string) =>
  Uint8Array.from(md, (c: string) => c.charCodeAt(0))

interface WalkOpts {
  cigar: string
  seq: string
  md?: string
  ref?: string
  /** where `ref` starts, when it is not the read's own start */
  refRegionStart?: number
  qual?: number[]
  /** the read's own start; every reported position is absolute */
  start?: number
  windowStart?: number
  windowEnd?: number
}

function walk(opts: WalkOpts) {
  const start = opts.start ?? 0
  const out: Mismatch[] = []
  forEachMismatchNumeric(
    encodeCigar(opts.cigar),
    encodeSeq(opts.seq),
    opts.seq.length,
    opts.md === undefined ? undefined : encodeMD(opts.md),
    opts.qual === undefined ? undefined : new Uint8Array(opts.qual),
    opts.ref === undefined
      ? undefined
      : packReference(opts.ref, opts.refRegionStart ?? start),
    start,
    opts.windowStart ?? Number.NEGATIVE_INFINITY,
    opts.windowEnd ?? Number.POSITIVE_INFINITY,
    (code, refPos, length, bases, qual, refBaseCode, clipLength) => {
      out.push({ code, refPos, length, bases, qual, refBaseCode, clipLength })
    },
  )
  return out
}

// the readable form of a Mismatch, so failures say what actually came out.
// SYNC: ~/src/gmod/cram-js test/mismatches.test.ts, same format
const show = (m: Mismatch) =>
  `${String.fromCharCode(m.code)}@${m.refPos}` +
  (m.length ? `/${m.length}ref` : '') +
  (m.bases ? `/"${m.bases}"` : '') +
  (m.clipLength ? `/${m.clipLength}read` : '') +
  (m.refBaseCode ? `/ref${String.fromCharCode(m.refBaseCode)}` : '') +
  (m.qual === -1 ? '' : `/q${m.qual}`)

const mismatchesOf = (opts: WalkOpts) => walk(opts).map(show)

describe('substitutions from the MD tag', () => {
  test('one substitution reports the read base and the reference base', () => {
    expect(
      mismatchesOf({ cigar: '10M', seq: 'AAAAAAAAAA', md: '5T4' }),
    ).toEqual(['X@5/1ref/"A"/refT'])
  })

  test('several substitutions in one M op', () => {
    expect(
      mismatchesOf({ cigar: '10M', seq: 'ACGTACGTAC', md: '2A2T4' }),
    ).toEqual(['X@2/1ref/"G"/refA', 'X@5/1ref/"C"/refT'])
  })

  test('positions are absolute, i.e. relative to the record start', () => {
    expect(
      mismatchesOf({ cigar: '10M', seq: 'AAAAAAAAAA', md: '5T4', start: 100 }),
    ).toEqual(['X@105/1ref/"A"/refT'])
  })

  test('a substitution carries the quality score of its read base', () => {
    expect(
      mismatchesOf({
        cigar: '4M',
        seq: 'AAAA',
        md: '2T1',
        qual: [10, 11, 12, 13],
      }),
    ).toEqual(['X@2/1ref/"A"/refT/q12'])
  })

  test("MD's deleted bases are stepped over, not read as matches", () => {
    // ^AC is the two deleted reference bases; the T after it is a substitution
    // three bases further on, which is only right if the ^AC was consumed
    expect(
      mismatchesOf({ cigar: '5M2D5M', seq: 'AAAAAAAAAA', md: '5^AC2T2' }),
    ).toEqual(['D@5/2ref', 'X@9/1ref/"A"/refT'])
  })

  test('MD is followed across insertions and clips, which it does not cover', () => {
    expect(
      mismatchesOf({
        cigar: '2S3M2I3M',
        seq: 'TTAAAGGAAA',
        md: '3C2',
      }),
    ).toEqual(['S@0/2read', 'I@3/"GG"/2read', 'X@3/1ref/"A"/refC'])
  })
})

describe('substitutions from a reference, for a read with no MD', () => {
  test('finds them by comparing SEQ against the reference', () => {
    expect(
      mismatchesOf({ cigar: '10M', seq: 'AAAAAAAAAA', ref: 'AAAAATAAAA' }),
    ).toEqual(['X@5/1ref/"A"/refT'])
  })

  test('the comparison is case-insensitive, and reports upper case', () => {
    expect(
      mismatchesOf({ cigar: '10M', seq: 'ACGTACGTAC', ref: 'acgtacgtac' }),
    ).toEqual([])
    expect(mismatchesOf({ cigar: '2M', seq: 'AC', ref: 'ag' })).toEqual([
      'X@1/1ref/"C"/refG',
    ])
  })

  test('every base can mismatch', () => {
    expect(
      mismatchesOf({ cigar: '4M', seq: 'ACGT', ref: 'TGCA' }),
    ).toHaveLength(4)
  })

  test('MD wins when the read has both', () => {
    // the reference says position 0, MD says position 5; MD is what the aligner
    // asserted, and is what a read carrying one is resolved from
    expect(
      mismatchesOf({
        cigar: '10M',
        seq: 'AAAAAAAAAA',
        md: '5T4',
        ref: 'TAAAAAAAAA',
      }),
    ).toEqual(['X@5/1ref/"A"/refT'])
  })

  test('a region offset from the read start lines up correctly', () => {
    expect(
      mismatchesOf({
        cigar: '4M',
        seq: 'AAAA',
        start: 103,
        ref: 'GGGAATAA',
        refRegionStart: 100,
      }),
    ).toEqual(['X@105/1ref/"A"/refT'])
  })

  test('bases the region does not cover are left uncompared', () => {
    // the region starts three bases into the read and ends two before its end,
    // so only the middle is resolved — but the clips at both ends still report
    expect(
      mismatchesOf({
        cigar: '2S10M2S',
        seq: 'TTGGGGGGGGGGTT',
        start: 100,
        ref: 'TTTTT',
        refRegionStart: 103,
      }),
    ).toEqual([
      'S@100/2read',
      'X@103/1ref/"G"/refT',
      'X@104/1ref/"G"/refT',
      'X@105/1ref/"G"/refT',
      'X@106/1ref/"G"/refT',
      'X@107/1ref/"G"/refT',
      'S@110/2read',
    ])
  })
})

describe('with neither MD nor a reference', () => {
  test('no substitutions are reported, since nothing says where they are', () => {
    expect(mismatchesOf({ cigar: '10M', seq: 'AAAAAAAAAA' })).toEqual([])
  })

  test('indels, skips and clips are reported in full', () => {
    expect(
      mismatchesOf({ cigar: '2S3M1I3M2D3M100N3M2H', seq: 'TTAAAGAAAAAAAA' }),
    ).toEqual([
      'S@0/2read',
      'I@3/"G"/1read',
      'D@6/2ref',
      'N@11/100ref',
      'H@114/2read',
    ])
  })
})

describe('insertions', () => {
  test.each([
    ['1M1I5M', 'ATAAAAA', 'I@1/"T"/1read'], // odd read offset, 1 base
    ['2M1I5M', 'AAGAAAAA', 'I@2/"G"/1read'], // even read offset, 1 base
    ['5M2I5M', 'AAAAATTAAAAA', 'I@5/"TT"/2read'],
    ['3M3I4M', 'AAATCGAAAA', 'I@3/"TCG"/3read'],
  ])('%s %s', (cigar, seq, expected) => {
    expect(mismatchesOf({ cigar, seq })).toEqual([expected])
  })
})

describe('an --eqx CIGAR, which carries its substitutions in X ops', () => {
  test('X reports the read base, and no reference base when nothing supplies one', () => {
    expect(mismatchesOf({ cigar: '5M1X4M', seq: 'AAAAATAAAA' })).toEqual([
      'X@5/1ref/"T"',
    ])
  })

  test('the reference base comes from MD when present', () => {
    expect(
      mismatchesOf({ cigar: '5=1X4=', seq: 'AAAAATAAAA', md: '5A4' }),
    ).toEqual(['X@5/1ref/"T"/refA'])
  })

  test('and from the region otherwise', () => {
    expect(
      mismatchesOf({ cigar: '5=1X4=', seq: 'AAAAATAAAA', ref: 'AAAAAGAAAA' }),
    ).toEqual(['X@5/1ref/"T"/refG'])
  })

  test('= is resolved against the reference exactly like M', () => {
    expect(
      mismatchesOf({ cigar: '10=', seq: 'AAAAAAAAAA', ref: 'AATAAAAATA' }),
    ).toHaveLength(2)
  })
})

describe('a read stored with no sequence (SEQ of *)', () => {
  test('reports the ops that need no bases', () => {
    expect(mismatchesOf({ cigar: '2S5=2I5=3N5=', seq: '' })).toEqual([
      'S@0/2read',
      'I@5/2read',
      'N@10/3ref',
    ])
  })

  test('X still consumes the reference', () => {
    // not advancing past it put every later op that many bases too far left
    expect(mismatchesOf({ cigar: '5=3X5=4D5=', seq: '' })).toEqual([
      'D@13/4ref',
    ])
  })
})

describe('the reporting window', () => {
  // a read with a mismatch, an insertion, a deletion, a skip and another
  // mismatch spread across reference offsets
  const base = {
    cigar: '5M2I5M3D5M4N5M',
    seq: 'AAGAACCAAAAAAAAAAAGAAA',
    ref: 'a'.repeat(27),
    start: 100,
  }

  test('the whole read, for comparison', () => {
    expect(mismatchesOf(base)).toEqual([
      'X@102/1ref/"G"/refA',
      'I@105/"CC"/2read',
      'D@110/3ref',
      'N@118/4ref',
      'X@123/1ref/"G"/refA',
    ])
  })

  test('windowed output equals the full walk filtered to the window', () => {
    const all = walk(base)
    for (const [lo, hi] of [
      [100, 105],
      [103, 112],
      [110, 120],
      [121, 130],
      [106, 106],
    ]) {
      const expected = all.filter(m =>
        // deletions and skips overlap the window; everything else falls in it
        m.length > 1
          ? m.refPos < hi! && m.refPos + m.length > lo!
          : m.refPos >= lo! && m.refPos < hi!,
      )
      expect(walk({ ...base, windowStart: lo, windowEnd: hi })).toEqual(
        expected,
      )
    }
  })

  test('the window is half-open, unlike @gmod/cram’s', () => {
    // the substitution at 102 is in [102, 103) and not in [100, 102)
    expect(mismatchesOf({ ...base, windowStart: 102, windowEnd: 103 })).toEqual(
      ['X@102/1ref/"G"/refA'],
    )
    expect(mismatchesOf({ ...base, windowStart: 100, windowEnd: 102 })).toEqual(
      [],
    )
  })

  test('a window off either end of the read reports nothing', () => {
    expect(mismatchesOf({ ...base, windowStart: 0, windowEnd: 50 })).toEqual([])
    expect(
      mismatchesOf({ ...base, windowStart: 1000, windowEnd: 2000 }),
    ).toEqual([])
  })

  test('windowing the MD path matches windowing the reference path', () => {
    const md = { cigar: '10M', seq: 'ACGTACGTAC', md: '2A2T4', start: 100 }
    const ref = {
      cigar: '10M',
      seq: 'ACGTACGTAC',
      ref: 'ACATATGTAC',
      start: 100,
    }
    for (let lo = 99; lo < 112; lo++) {
      const w = { windowStart: lo, windowEnd: lo + 3 }
      expect(mismatchesOf({ ...md, ...w })).toEqual(
        mismatchesOf({ ...ref, ...w }),
      )
    }
  })
})

// The reference comparison packs both the read's SEQ and the reference two
// bases to a byte and compares a byte at a time, so it has to line the two up
// itself: a read whose sequence offset and reference offset disagree in parity,
// an M op of odd length, or a window starting mid-byte all leave single bases
// at the ends of the paired run. This walks randomized CIGAR/seq/ref/offset
// combinations against a naive per-base oracle, which is where those alignment
// cases actually live.
describe('the packed reference comparison against a naive per-base oracle', () => {
  const BASES = 'ACGT'

  // deterministic LCG so a failure is reproducible from its seed
  function makeRandom(seed: number) {
    let state = seed
    return (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state % n
    }
  }

  function naiveMismatches(
    cigar: { len: number; op: string }[],
    seq: string,
    ref: string,
    refOffset: number,
    start: number,
  ) {
    const out: string[] = []
    let roffset = 0
    let soffset = 0
    for (const { len, op } of cigar) {
      if (op === 'M') {
        for (let j = 0; j < len; j++) {
          const readBase = seq[soffset + j]!
          const refBase = ref[refOffset + roffset + j]!
          if (readBase.toLowerCase() !== refBase.toLowerCase()) {
            out.push(
              `X@${start + roffset + j}/1ref/"${readBase}"/ref${refBase.toUpperCase()}`,
            )
          }
        }
        soffset += len
        roffset += len
      } else if (op === 'I' || op === 'S') {
        // both consume query and not reference
        soffset += len
      } else if (op === 'D') {
        roffset += len
      }
    }
    return out
  }

  test.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', seed => {
    const random = makeRandom(seed)
    for (let trial = 0; trial < 40; trial++) {
      // a CIGAR mixing odd/even run lengths and both offset-shifting ops
      const ops: { len: number; op: string }[] = []
      const opChoices = ['M', 'M', 'M', 'I', 'D', 'S']
      for (let i = 0; i < 1 + random(5); i++) {
        ops.push({
          len: 1 + random(9),
          op: i === 0 ? 'M' : opChoices[random(opChoices.length)]!,
        })
      }
      const seqLen = ops
        .filter(o => o.op === 'M' || o.op === 'I' || o.op === 'S')
        .reduce((a, b) => a + b.len, 0)
      const refLen = ops
        .filter(o => o.op === 'M' || o.op === 'D')
        .reduce((a, b) => a + b.len, 0)
      // how far into the region the read starts, which is what puts the two
      // packings out of parity with each other
      const refOffset = random(4)
      const start = 1000 + random(4)
      let seq = ''
      for (let i = 0; i < seqLen; i++) {
        seq += BASES[random(4)]!
      }
      let ref = ''
      for (let i = 0; i < refOffset + refLen; i++) {
        // mixed case, since the comparison is case-insensitive
        const c = BASES[random(4)]!
        ref += random(2) ? c : c.toLowerCase()
      }

      const cigar = ops.map(o => `${o.len}${o.op}`).join('')
      const actual = mismatchesOf({
        cigar,
        seq,
        ref,
        start,
        refRegionStart: start - refOffset,
      }).filter(m => m.startsWith('X'))

      expect({ cigar, seq, ref, refOffset, actual }).toEqual({
        cigar,
        seq,
        ref,
        refOffset,
        actual: naiveMismatches(ops, seq, ref, refOffset, start),
      })
    }
  })
})

test('the codes are @gmod/cram’s vocabulary, i.e. CIGAR char codes', () => {
  expect([
    MISMATCH_SUBST,
    MISMATCH_INSERTION,
    MISMATCH_DELETION,
    MISMATCH_REF_SKIP,
    MISMATCH_SOFT_CLIP,
    MISMATCH_HARD_CLIP,
  ]).toEqual(Array.from('XIDNSH', (c: string) => c.charCodeAt(0)))
})
