import { readFileSync } from 'node:fs'

import { expect, test } from 'vitest'

import {
  BamFile,
  BamRecord,
  MISMATCH_SUBST,
  forEachMismatchNumeric,
  packReference,
} from '../src/index.ts'

import type { Mismatch, PackedReference } from '../src/index.ts'

// volvox.fa is the reference volvox-sorted.bam was aligned to — the same
// fixture pair jbrowse-components ships — so it can stand in judgement over
// what the reads' own MD tags say.
const volvoxCtgA = readFileSync('test/data/volvox.fa', 'utf8')
  .split('>')[1]!
  .split('\n')
  .slice(1)
  .join('')

const show = (m: Mismatch) =>
  `${String.fromCharCode(m.code)}@${m.refPos}` +
  (m.length ? `/${m.length}ref` : '') +
  (m.bases ? `/"${m.bases}"` : '') +
  (m.clipLength ? `/${m.clipLength}read` : '') +
  (m.refBaseCode ? `/ref${String.fromCharCode(m.refBaseCode)}` : '') +
  (m.qual === -1 ? '' : `/q${m.qual}`)

// M/=/X consume both read and reference, so an aligned base of the read sits
// opposite a base of the reference
const CIGAR_ALIGNED = new Set([0, 7, 8])

/**
 * The reference over one read's span, rebuilt from the read itself: an aligned
 * base is the read's own base unless the read's MD tag says it is a
 * substitution, in which case MD names the reference base. Deleted and skipped
 * positions are unknowable this way and come back as N, which is harmless
 * because no read base is compared against them.
 *
 * Which makes the two resolution paths comparable on real data: a read carrying
 * MD, walked against this, has to report exactly what it reports from its MD.
 */
function referenceFromRecord(record: BamRecord) {
  const out = new Array<string>(record.end - record.start).fill('N')
  let roffset = 0
  let soffset = 0
  for (const packed of record.NUMERIC_CIGAR) {
    const len = packed >>> 4
    const op = packed & 0xf
    if (CIGAR_ALIGNED.has(op)) {
      for (let j = 0; j < len; j++) {
        out[roffset + j] = record.seqAt(soffset + j)!
      }
      roffset += len
      soffset += len
    } else if (op === 1 || op === 4) {
      soffset += len
    } else if (op === 2 || op === 3) {
      roffset += len
    }
  }
  for (const m of record.getMismatches()) {
    if (m.code === MISMATCH_SUBST && m.refBaseCode) {
      out[m.refPos - record.start] = String.fromCharCode(m.refBaseCode)
    }
  }
  return out.join('')
}

/** the same walk with the MD tag withheld, so the reference has to do the work */
function withoutMD(record: BamRecord, ref: PackedReference) {
  const out: Mismatch[] = []
  forEachMismatchNumeric(
    record.NUMERIC_CIGAR,
    record.NUMERIC_SEQ,
    record.seq_length,
    undefined,
    record.qual,
    ref,
    record.start,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    (code, refPos, length, bases, qual, refBaseCode, clipLength) => {
      out.push({ code, refPos, length, bases, qual, refBaseCode, clipLength })
    },
  )
  return out
}

test('mismatches of real reads carrying MD', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ctgA', 0, 1000)
  expect(
    records
      .slice(0, 8)
      .map(
        r => `${r.name} ${r.CIGAR}: ${r.getMismatches().map(show).join(' ')}`,
      ),
  ).toMatchInlineSnapshot(`
      [
        "ctgA_3_555_0:0:0_2:0:0_102d 100M: ",
        "ctgA_8_507_4:0:0_2:0:0_10e6 100M: X@17/1ref/"G"/refA/q17 X@55/1ref/"T"/refA/q17 X@63/1ref/"A"/refG/q17 X@83/1ref/"C"/refT/q17",
        "ctgA_16_523_3:0:0_0:0:0_1a75 100M: X@41/1ref/"A"/refT/q17 X@73/1ref/"G"/refT/q17 X@103/1ref/"A"/refG/q17",
        "ctgA_17_531_4:0:0_2:0:0_b65 100M: X@69/1ref/"G"/refT/q17 X@75/1ref/"T"/refA/q17 X@78/1ref/"G"/refC/q17 X@85/1ref/"A"/refT/q17",
        "ctgA_18_445_3:0:0_2:0:0_22df 100M: X@23/1ref/"C"/refG/q17 X@86/1ref/"G"/refA/q17 X@111/1ref/"C"/refT/q17",
        "ctgA_43_557_1:0:0_2:0:0_5b3 100M: X@104/1ref/"T"/refG/q17",
        "ctgA_44_560_2:0:0_5:0:0_2524 100M: X@43/1ref/"C"/refT/q17 X@134/1ref/"A"/refG/q17",
        "ctgA_48_502_2:0:0_1:0:0_1513 100M: X@48/1ref/"A"/refC/q17 X@51/1ref/"A"/refT/q17",
      ]
    `)
})

test('MD and the real reference agree, over every read of volvox', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ctgA', 0, 50001)
  expect(records.length).toBeGreaterThan(9000)
  const ref = packReference(volvoxCtgA, 0)
  let substitutions = 0
  for (const record of records) {
    const fromMD = record.getMismatches()
    const fromRef = withoutMD(record, ref)
    expect(fromRef.map(show)).toEqual(fromMD.map(show))
    substitutions += fromMD.filter(m => m.code === MISMATCH_SUBST).length
  }
  // the agreement above is only worth something if there is something to agree
  // about: ~2 substitutions per read across the pileup
  expect(substitutions).toBeGreaterThan(10000)
})

test('MD and a reference rebuilt from the reads agree, on a file with deletions', async () => {
  const bam = new BamFile({
    bamPath: 'test/data/test_deletion_2_0.snps.bwa_align.sorted.grouped.bam',
  })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('Chromosome', 0, 20000)
  expect(records.length).toBeGreaterThan(100)
  let deletions = 0
  for (const record of records) {
    expect(record.NUMERIC_MD).toBeDefined()
    const fromMD = record.getMismatches()
    const fromRef = withoutMD(
      record,
      packReference(referenceFromRecord(record), record.start),
    )
    expect(fromRef.map(show)).toEqual(fromMD.map(show))
    deletions += fromMD.filter(m => m.length > 1).length
  }
  expect(deletions).toBeGreaterThan(0)
})

// A read that hides its MD tag is the only way to make volvox — where every
// read has one — take the reference path end to end, and it is worth doing
// because volvox is the file whose true reference we have.
class NoMDRecord extends BamRecord {
  override get NUMERIC_MD() {
    return undefined
  }
}

test('fetchReferenceSequence resolves a whole query, matching what MD says', async () => {
  const asked: [string, number, number][] = []
  const bam = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    recordClass: NoMDRecord,
    fetchReferenceSequence: async (refName, start, end) => {
      expect(refName).toBe('ctgA')
      asked.push([refName, start, end])
      return volvoxCtgA.slice(start, end)
    },
  })
  const withMD = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await Promise.all([bam.getHeader(), withMD.getHeader()])

  const records = await bam.getRecordsForRange('ctgA', 20000, 21000)
  const expected = await withMD.getRecordsForRange('ctgA', 20000, 21000)
  expect(records).toHaveLength(expected.length)
  expect(records.length).toBeGreaterThan(100)
  expect(asked).toHaveLength(1)

  for (let i = 0; i < records.length; i++) {
    expect(records[i]!.name).toBe(expected[i]!.name)
    expect(records[i]!.getMismatches().map(show)).toEqual(
      expected[i]!.getMismatches().map(show),
    )
  }
})

test('a query whose reads all carry MD asks for no reference at all', async () => {
  let calls = 0
  const bam = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    fetchReferenceSequence: async () => {
      calls++
      return ''
    },
  })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ctgA', 0, 1000)
  expect(records.length).toBeGreaterThan(0)
  expect(calls).toBe(0)
  expect(records[0]!.reference).toBeUndefined()
})

// ecoli_nanopore is long reads with no MD anywhere, i.e. the case the option
// exists for. The reference it is served is synthetic — what is under test is
// the plumbing, and a made-up reference exercises it harder than a real one
// would (every base is a candidate mismatch).
const fakeReference = (start: number, end: number) => {
  let seq = ''
  for (let i = start; i < end; i++) {
    seq += 'ACGT'[(i * 7919) % 4]!
  }
  return seq
}

test('reads with no MD are resolved against a fetched reference', async () => {
  const asked: [string, number, number][] = []
  const bam = new BamFile({
    bamPath: 'test/data/ecoli_nanopore.bam',
    fetchReferenceSequence: async (refName, start, end) => {
      asked.push([refName, start, end])
      return fakeReference(start, end)
    },
  })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ref000001|chr', 10000, 20000)
  expect(records.length).toBeGreaterThan(0)

  // one fetch, over the union of the reads rather than the queried range: these
  // are 10kb+ reads, so they overhang it in both directions
  expect(asked).toHaveLength(1)
  const [refName, start, end] = asked[0]!
  expect(refName).toBe('ref000001|chr')
  expect(start).toBe(Math.min(...records.map(r => r.start)))
  expect(end).toBe(Math.max(...records.map(r => r.end)))
  expect(start).toBeLessThan(10000)
  expect(end).toBeGreaterThan(20000)

  for (const record of records) {
    expect(record.reference).toBeDefined()
  }

  // every substitution the walk reports really is one, and it reports all of
  // them: checked against a naive per-base comparison of the read against the
  // same synthetic reference
  const record = records[0]!
  const expected: string[] = []
  let roffset = 0
  let soffset = 0
  for (const packed of record.NUMERIC_CIGAR) {
    const len = packed >>> 4
    const op = packed & 0xf
    if (CIGAR_ALIGNED.has(op)) {
      for (let j = 0; j < len; j++) {
        const pos = record.start + roffset + j
        const readBase = record.seqAt(soffset + j)!
        const refBase = fakeReference(pos, pos + 1)
        if (readBase !== refBase) {
          expect(record.qual).toBeDefined()
          expected.push(
            `X@${pos}/1ref/"${readBase}"/ref${refBase}/q${record.qual![soffset + j]}`,
          )
        }
      }
      roffset += len
      soffset += len
    } else if (op === 1 || op === 4) {
      soffset += len
    } else if (op === 2 || op === 3) {
      roffset += len
    }
  }
  expect(expected.length).toBeGreaterThan(100)
  expect(
    record
      .getMismatches()
      .filter(m => m.code === MISMATCH_SUBST)
      .map(show),
  ).toEqual(expected)
})

test('without the option, reads with no MD still report their indels and clips', async () => {
  const bam = new BamFile({ bamPath: 'test/data/ecoli_nanopore.bam' })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ref000001|chr', 10000, 20000)
  const mismatches = records[0]!.getMismatches()
  expect(records[0]!.reference).toBeUndefined()
  expect(mismatches.filter(m => m.code === MISMATCH_SUBST)).toHaveLength(0)
  expect(mismatches.length).toBeGreaterThan(100)
})

test('a callback that returns less than it was asked for leaves the reads it misses unbound', async () => {
  const bam = new BamFile({
    bamPath: 'test/data/ecoli_nanopore.bam',
    // a source that stops at 18000 — the end of a contig, or one declining to
    // hand over a span this big. The bases still start where they were asked
    // to, which is the part that cannot be relaxed.
    fetchReferenceSequence: async (_refName, start, end) =>
      fakeReference(start, Math.min(end, 18000)),
  })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ref000001|chr', 10000, 20000)
  const bound = records.filter(r => r.reference !== undefined)
  const unbound = records.filter(r => r.reference === undefined)
  expect(bound.length).toBeGreaterThan(0)
  expect(unbound.length).toBeGreaterThan(0)
  // exactly the reads the short region covers were bound to it
  for (const record of bound) {
    expect(record.end).toBeLessThanOrEqual(18000)
  }
  for (const record of unbound) {
    expect(record.end).toBeGreaterThan(18000)
  }
  // and an unbound read reports its indels but not its substitutions
  const mismatches = unbound[0]!.getMismatches()
  expect(mismatches.length).toBeGreaterThan(0)
  expect(mismatches.filter(m => m.code === MISMATCH_SUBST)).toHaveLength(0)
})

test('a region that does not cover the whole read cannot be bound to it', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const record = (await bam.getRecordsForRange('ctgA', 0, 1000))[0]!
  expect(() => {
    record.setReference(packReference('ACGT', record.start))
  }).toThrow(/does not cover the record/)

  // ...but walking with a partial region is fine, since nothing is retained.
  // A read with no MD, resolved against the first 100 bases of its own span:
  // every substitution reported lies inside them.
  const ecoli = new BamFile({ bamPath: 'test/data/ecoli_nanopore.bam' })
  await ecoli.getHeader()
  const long = (
    await ecoli.getRecordsForRange('ref000001|chr', 10000, 20000)
  )[0]!
  const partial = packReference(
    fakeReference(long.start, long.start + 100),
    long.start,
  )
  const substitutions = long
    .getMismatches({ ref: partial })
    .filter(m => m.code === MISMATCH_SUBST)
  expect(substitutions.length).toBeGreaterThan(0)
  for (const m of substitutions) {
    expect(m.refPos).toBeLessThan(long.start + 100)
  }
})

test('getReferenceRegion packs what the callback returns, and nothing without one', async () => {
  const plain = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  expect(await plain.getReferenceRegion('ctgA', 0, 10)).toBeUndefined()

  const bam = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    fetchReferenceSequence: async (_refName, start, end) =>
      fakeReference(start, end),
  })
  const ref = await bam.getReferenceRegion('ctgA', 100, 110)
  expect(ref).toMatchObject({ start: 100, length: 10 })
})

test('the window narrows what a record reports, and nothing else', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const records = await bam.getRecordsForRange('ctgA', 0, 5000)
  for (const record of records.slice(0, 200)) {
    const all = record.getMismatches()
    const mid = Math.floor((record.start + record.end) / 2)
    const windowed = record.getMismatches({ start: record.start, end: mid })
    expect(windowed.map(show)).toEqual(
      all
        .filter(m =>
          m.length > 1
            ? m.refPos < mid && m.refPos + m.length > record.start
            : m.refPos >= record.start && m.refPos < mid,
        )
        .map(show),
    )
  }
})
