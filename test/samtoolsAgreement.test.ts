// Every indexed BAM in test/data, queried against samtools.
//
// The unit tests elsewhere pin what this reader returns; this pins that it
// returns what htslib returns. Those are different claims, and only the second
// one catches a filter that is self-consistently wrong — which is how a
// one-base error at the left edge of every window survived for years.
//
// Regions are chosen to land exactly on record edges rather than at round
// numbers, since that is where inclusive/exclusive mistakes live. The
// comparison at each region is over the full result set, keyed on
// QNAME|FLAG|POS, so it catches a record wrongly included as readily as one
// wrongly dropped.
//
// Skipped, not failed, when samtools is absent, so a contributor without it can
// still run the suite. `covers enough of the corpus to be meaningful` fails if
// that skipping ever leaves the comparison testing nothing.
import { existsSync, readdirSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

import { BamFile } from '../src/index.ts'
import {
  boundaryWindows,
  records as samtoolsRecords,
  references,
  refsWithRecords,
  samtoolsAvailable,
  samtoolsVersion,
  sortedness,
} from './lib/samtools.ts'

const DATA = 'test/data'

const indexedBams = readdirSync(DATA)
  .filter(f => f.endsWith('.bam'))
  .filter(f => existsSync(`${DATA}/${f}.bai`) || existsSync(`${DATA}/${f}.csi`))
  .sort()

const available = samtoolsAvailable()
let comparisons = 0
const skipped: string[] = []

describe.skipIf(!available)(`agreement with ${available ? samtoolsVersion() : 'samtools'}`, () => {
  test.each(indexedBams)('%s matches samtools', async name => {
    const path = `${DATA}/${name}`
    const bam = new BamFile({
      bamPath: path,
      csiPath: existsSync(`${path}.csi`) ? `${path}.csi` : undefined,
    })
    await bam.getHeader()

    const refs = references(path)
    const present = refsWithRecords(path)
    // one pass for the whole file rather than one per reference
    const sorted = sortedness(path)
    if (!refs || !present) {
      // samtools cannot read this fixture, so it cannot arbitrate it either
      skipped.push(name)
      return
    }

    for (const ref of refs.filter(r => present.has(r.name))) {
      const all = await bam.getRecordsForRange(ref.name, 0, ref.length)
      if (all.length === 0) {
        continue
      }

      // htslib's region iterator assumes coordinate order, so on a file that is
      // not sorted it returns a prefix of the right answer rather than the
      // answer. Judged from the file's own record order. See sortedness().
      if (sorted?.get(ref.name) === false) {
        skipped.push(`${name}:${ref.name} (not coordinate sorted)`)
        continue
      }

      for (const [min, max] of boundaryWindows(all, ref.length)) {
        const mine = await bam.getRecordsForRange(ref.name, min, max)
        const ours = mine.map(r => `${r.name}|${r.flags}|${r.start + 1}`).sort()
        const theirs = samtoolsRecords(path, ref.name, min, max).sort()
        comparisons++
        expect(
          { region: `${ref.name}:${min}-${max}`, records: ours },
          `${name} ${ref.name}:${min}-${max} (0-based, half-open)`,
        ).toStrictEqual({ region: `${ref.name}:${min}-${max}`, records: theirs })
      }
    }
    // The largest fixtures are ~13 MB of long reads, read once per window and
    // once more by samtools, so this is well past the default 5s.
  }, 180_000)

  // A run where every file quietly errored out, or where the region generator
  // stopped producing windows, would otherwise pass while checking nothing.
  test('covers enough of the corpus to be meaningful', () => {
    if (skipped.length) {
      console.warn(`samtools could not read, so not arbitrated: ${skipped.join(', ')}`)
    }
    expect(indexedBams.length).toBeGreaterThanOrEqual(20)
    expect(skipped.length).toBeLessThanOrEqual(2)
    expect(comparisons).toBeGreaterThanOrEqual(100)
  })
})

// The coverage guard above lives inside the skipIf'd describe, so it skips
// along with the suite and cannot report its own absence: with samtools
// missing, every case here silently passes by not running. CI installs it, and
// this fails loudly if that ever stops being true.
test.skipIf(!process.env.CI)('samtools is installed in CI', () => {
  expect(available).toBe(true)
})
