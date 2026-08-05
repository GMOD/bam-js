import { expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'

// `end` is exclusive, so a read finishing exactly where a query begins shares no
// base with it. The filter used to accept `end >= min`, which returned one extra
// read at the left edge of every window.
//
// Ground truth is samtools 1.23.1 / htslib 1.23.1, whose regions are 1-based and
// inclusive on both ends: the 0-based half-open [a, b) used here is `a+1`-`b`.

// samtools view -c test/data/volvox-sorted.bam ctgA:1-100000 -> 9596
test('record count matches samtools', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  expect((await bam.getRecordsForRange('ctgA', 0, 100_000)).length).toBe(9596)
})

test('a read is dropped once the query starts at its exclusive end', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const read = (await bam.getRecordsForRange('ctgA', 0, 100_000)).find(
    r => r.end - r.start > 10,
  )!
  expect(read).toBeDefined()

  const has = (records: (typeof read)[]) =>
    records.some(
      r =>
        r.name === read.name &&
        r.start === read.start &&
        r.flags === read.flags,
    )

  // last base the read covers is end - 1, so a query starting there still hits
  expect(
    has(await bam.getRecordsForRange('ctgA', read.end - 1, read.end + 5000)),
  ).toBe(true)
  // and one base later it must not
  expect(
    has(await bam.getRecordsForRange('ctgA', read.end, read.end + 5000)),
  ).toBe(false)
})

// A record consuming no reference — an unmapped mate placed at its mate's
// coordinate — still has to be findable by a query on the base it sits at, the
// way htslib's bam_endpos() reports one base rather than zero for it. Guards
// against fixing the edge above by making `end > min` unconditional.
test('a zero-length placement is found at its own base', async () => {
  const bam = new BamFile({ bamPath: 'test/data/volvox-sorted.bam' })
  await bam.getHeader()
  const all = await bam.getRecordsForRange('ctgA', 0, 100_000)
  const empty = all.find(r => r.end === r.start)
  if (!empty) {
    return // this file has none; the invariant is exercised by unmapped-mate data
  }
  expect(
    (await bam.getRecordsForRange('ctgA', empty.start, empty.start + 1)).some(
      r => r.name === empty.name && r.start === empty.start,
    ),
  ).toBe(true)
})
