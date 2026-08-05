import { expect, test, vi } from 'vitest'

import BamRecord from '../src/record.ts'

// Build a minimal BAM alignment record (SAMv1.pdf §4.2) carrying a single 'B'
// (array) tag, with no read bases. Layout from the record start:
//   block_size i32 | refID i32 | pos i32 | bin_mq_nl i32 | flag_nc i32 |
//   l_seq i32 | next_refID i32 | next_pos i32 | tlen i32 |
//   read_name (l_read_name, null-terminated) | cigar | seq | qual | tags
function makeRecordWithBTag(
  tagName: string,
  subtype: number,
  writeValues: (dv: DataView, p: number) => number,
) {
  const readName = 'q\0'
  const lReadName = readName.length
  const fixedEnd = 36 + lReadName // no cigar, no seq, no qual
  // tag = name(2) + type(1) + subtype(1) + count(4) + payload
  const buf = new Uint8Array(256)
  const dv = new DataView(buf.buffer)

  dv.setInt32(4, 0, true) // refID
  dv.setInt32(8, 0, true) // pos
  dv.setInt32(12, lReadName, true) // bin_mq_nl: l_read_name in low byte
  dv.setInt32(16, 0, true) // flag_nc: 0 cigar ops, flags 0
  dv.setInt32(20, 0, true) // l_seq
  dv.setInt32(24, -1, true) // next_refID
  dv.setInt32(28, 0, true) // next_pos
  dv.setInt32(32, 0, true) // tlen
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0

  let p = fixedEnd
  buf[p++] = tagName.charCodeAt(0)
  buf[p++] = tagName.charCodeAt(1)
  buf[p++] = 0x42 // 'B'
  buf[p++] = subtype
  const end = writeValues(dv, p)

  dv.setInt32(0, end - 4, true) // block_size = bytes following this field
  return new BamRecord(buf, 0, end - 1, 0, dv)
}

test('B tag int32 array via tags and getTag', () => {
  const values = [10, 20, 30]
  const rec = makeRecordWithBTag('Bi', 0x69, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setInt32(p, v, true)
      p += 4
    }
    return p
  })
  expect([...(rec.tags.Bi as Int32Array | number[])]).toEqual(values)
  expect([...(rec.getTag('Bi') as Int32Array | number[])]).toEqual(values)
})

test('B tag float32 array', () => {
  const values = [1.5, -2.25, 3.75]
  const rec = makeRecordWithBTag('Bf', 0x66, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setFloat32(p, v, true)
      p += 4
    }
    return p
  })
  expect([...(rec.tags.Bf as Float32Array | number[])]).toEqual(values)
})

test('B tag uint8 array', () => {
  const values = [1, 2, 255]
  const rec = makeRecordWithBTag('Bc', 0x43, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setUint8(p, v)
      p += 1
    }
    return p
  })
  expect([...(rec.tags.Bc as Uint8Array)]).toEqual(values)
})

test('qual is returned for unmapped reads that carry bases', () => {
  const quals = [30, 40]
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true) // l_read_name = 2
  dv.setInt32(16, 0x4 << 16, true) // flag_nc: flag = BAM_FUNMAP, 0 cigar ops
  dv.setInt32(20, 2, true) // l_seq = 2
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0
  buf[38] = 0x12 // packed seq (2 bases)
  buf[39] = quals[0]!
  buf[40] = quals[1]!
  const rec = new BamRecord(buf, 0, 40, 0, dv)
  expect(rec.isSegmentUnmapped()).toBe(true)
  expect([...(rec.qual ?? [])]).toEqual(quals)
})

test('qual is null when there are no bases', () => {
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true)
  dv.setInt32(20, 0, true) // l_seq = 0
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0
  const rec = new BamRecord(buf, 0, 38, 0, dv)
  expect(rec.qual).toBeNull()
})

test('flags reads full uint16 without sign extension', () => {
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 1, true) // l_read_name = 1
  dv.setUint16(18, 0x8001, true) // flag with bit 15 set
  buf[36] = 0
  const rec = new BamRecord(buf, 0, 40, 0, dv)
  expect(rec.flags).toEqual(0x8001)
})

// Build a record whose SEQ is `bases`, so the two `seq` decode strategies (short
// string-concat vs long TextDecoder, split at SEQ_DECODER_THRESHOLD) can both be
// exercised against a known answer.
function makeRecordWithSeq(bases: string) {
  const len = bases.length
  const buf = new Uint8Array(64 + ((len + 1) >> 1))
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true) // bin_mq_nl: l_read_name = 2
  dv.setInt32(16, 0, true) // flag_nc: 0 cigar ops
  dv.setInt32(20, len, true) // l_seq
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0
  const seqStart = 38
  for (let i = 0; i < len; i++) {
    const nibble = '=ACMGRSVTWYHKDBN'.indexOf(bases[i]!)
    const j = seqStart + (i >> 1)
    buf[j] = buf[j]! | (i % 2 === 0 ? nibble << 4 : nibble)
  }
  const end = seqStart + ((len + 1) >> 1) + len
  dv.setInt32(0, end - 4, true)
  return new BamRecord(buf, 0, end - 1, 0, dv)
}

const SEQ_CASES = [
  ['empty', ''],
  ['single base', 'A'],
  ['even length', 'ACGT'],
  ['odd length', 'ACGTA'],
  // odd BYTE count exercises the 4-base table's leftover-pair branch, which the
  // 4-base-per-step loop cannot consume; the two above have an even one
  ['odd byte count', 'ACGTAC'],
  ['odd byte count, odd length', 'ACGTACG'],
  ['ambiguity codes', '=ACMGRSVTWYHKDBN'],
  // straddle the short/long decode threshold, including odd lengths on each side
  ['just under threshold', 'ACGTN'.repeat(59)], // 295
  ['odd, just over threshold', `${'ACGTN'.repeat(60)}A`], // 301
  ['long', 'ACGTNMRSVWYHKDB'.repeat(500)], // 7500
  ['long odd', `${'ACGTNMRSVWYHKDB'.repeat(500)}C`], // 7501
] as const

function checkSeq(bases: string) {
  const rec = makeRecordWithSeq(bases)
  expect(rec.seq).toBe(bases)
  expect(rec.seq_length).toBe(bases.length)
  // seqAt is an independent decode path; it must agree base for base
  let viaSeqAt = ''
  for (let i = 0; i < bases.length; i++) {
    viaSeqAt += rec.seqAt(i)
  }
  expect(viaSeqAt).toBe(bases)
  expect(rec.seqAt(bases.length)).toBeUndefined()
}

test.for(SEQ_CASES)('seq decodes %s', ([, bases]) => {
  checkSeq(bases)
})

// The sub-threshold decode has two implementations: a 2-base table, and a
// 4-base one that only switches on after SEQ_QUAD_WARMUP short decodes have
// happened process-wide. Everything above runs before that point, so without
// this the 4-base table — the one real queries end up using — is never
// executed by the suite at all.
test('seq decodes identically once the 4-base table warms up', () => {
  const warm = makeRecordWithSeq('ACGTACGTACGTACGT')
  for (let i = 0; i < 1100; i++) {
    expect(warm.seq).toBe('ACGTACGTACGTACGT')
  }
  for (const [, bases] of SEQ_CASES) {
    checkSeq(bases)
  }
})

test('tags do not resolve to Object.prototype members', () => {
  const rec = makeRecordWithSeq('ACGT')
  expect(rec.getTag('constructor')).toBeUndefined()
  expect(rec.tags.constructor).toBeUndefined()
  // same answer once the full tag object is built and getTag reads from it
  expect(rec.getTag('constructor')).toBeUndefined()
  expect(rec.getTag('toString')).toBeUndefined()
})

// Build a record whose tag block holds each of `tags` as a Z value, in order.
function makeRecordWithZTags(tags: [string, string][]) {
  const buf = new Uint8Array(1024)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true) // bin_mq_nl: l_read_name = 2
  dv.setInt32(24, -1, true) // next_refID
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0

  let p = 38
  for (const [name, value] of tags) {
    buf[p++] = name.charCodeAt(0)
    buf[p++] = name.charCodeAt(1)
    buf[p++] = 0x5a // 'Z'
    for (let i = 0; i < value.length; i++) {
      buf[p++] = value.charCodeAt(i)
    }
    buf[p++] = 0
  }
  dv.setInt32(0, p - 4, true) // block_size
  return new BamRecord(buf, 0, p - 1, 0, dv)
}

// getTagAlt resolves an alias pair in one pass; it must be indistinguishable
// from the `getTag(a) ?? getTag(b)` it replaces, including for the orderings a
// single walk could plausibly get wrong.
test.for([
  ['primary only', [['MM', 'C+m,1;']], 'C+m,1;'],
  ['alternate only', [['Mm', 'C+m,2;']], 'C+m,2;'],
  [
    'neither',
    [
      ['MD', '100'],
      ['RG', 'grp'],
    ],
    undefined,
  ],
  // primary must win from either side of the alternate, since a one-pass walk
  // meets whichever comes first
  [
    'both, primary first',
    [
      ['MM', 'first'],
      ['Mm', 'second'],
    ],
    'first',
  ],
  [
    'both, alternate first',
    [
      ['Mm', 'second'],
      ['MM', 'first'],
    ],
    'first',
  ],
  ['empty tag block', [], undefined],
] as [string, [string, string][], string | undefined][])(
  'getTagAlt matches getTag(a) ?? getTag(b): %s',
  ([, tags, expected]) => {
    const rec = makeRecordWithZTags(tags)
    expect(rec.getTagAlt('MM', 'Mm')).toBe(expected)
    // the form it replaces, on a record whose tag cache is still cold
    const fresh = makeRecordWithZTags(tags)
    expect(fresh.getTag('MM') ?? fresh.getTag('Mm')).toBe(expected)
    // and the same answer once `tags` has been built and the cache is used
    const cached = makeRecordWithZTags(tags)
    expect(Object.keys(cached.tags).length).toBe(tags.length)
    expect(cached.getTagAlt('MM', 'Mm')).toBe(expected)
  },
)

// Build a record carrying `NM:i:42` followed by a 'B' tag whose subtype is
// outside the spec's cCsSiIf, with a 4-byte-per-element payload.
function makeRecordWithUnknownBSubtype() {
  const buf = new Uint8Array(128)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true) // bin_mq_nl: l_read_name = 2
  dv.setInt32(24, -1, true) // next_refID
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0

  let p = 38
  buf[p++] = 'N'.charCodeAt(0)
  buf[p++] = 'M'.charCodeAt(0)
  buf[p++] = 0x69 // 'i'
  dv.setInt32(p, 42, true)
  p += 4

  buf[p++] = 'X'.charCodeAt(0)
  buf[p++] = 'B'.charCodeAt(0)
  buf[p++] = 0x42 // 'B'
  buf[p++] = 0x78 // 'x' — not a subtype the spec defines
  dv.setInt32(p, 2, true) // 2 elements
  p += 4
  // 8 bytes of payload, i.e. 4 bytes per element — six more than the one byte
  // per element the old width guess assumed. Every byte is a printable ASCII
  // letter, so a walk that resumes mid-payload keeps going on them rather than
  // obviously stopping.
  for (let i = 0; i < 8; i++) {
    buf[p++] = 'A'.charCodeAt(0) + i
  }

  dv.setInt32(0, p - 4, true) // block_size
  return new BamRecord(buf, 0, p - 1, 0, dv)
}

test('an unknown B tag subtype stops the walk instead of desyncing it', () => {
  // silenced, not passed through: the console.error is the point of the test
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const rec = makeRecordWithUnknownBSubtype()

  // The element width of an unknown subtype is unknowable, so the tag itself
  // is unreadable either way. What must not happen is the cursor advancing by
  // a guessed width: that used to publish `XB` with an undefined value and
  // then resume six bytes into the payload, reading whatever followed as the
  // next tag. Only the tags that genuinely precede it survive.
  expect(Object.keys(rec.tags)).toEqual(['NM'])
  expect(rec.tags.NM).toEqual(42)
  expect(Object.values(rec.tags).every(v => v !== undefined)).toBe(true)
  expect(errors).toHaveBeenCalled()

  // the single-tag lookup walks the same layout and must agree
  const fresh = makeRecordWithUnknownBSubtype()
  expect(fresh.getTag('NM')).toEqual(42)
  expect(fresh.getTag('XB')).toBeUndefined()
  errors.mockRestore()
})
