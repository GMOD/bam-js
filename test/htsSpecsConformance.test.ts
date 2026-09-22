// hts-specs' SAM conformance corpus, converted to BAM by samtools and read
// back field by field and tag by tag against `samtools view`. The corpus
// exercises every field and tag type, so this guards the record and tag
// decoders the way samtoolsAgreement.test.ts guards the index and filter.
//
// Skipped when samtools is absent, like samtoolsAgreement.test.ts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'vitest'

import { streamBamRecords } from '../src/index.ts'
import { qualString, samtoolsAvailable } from './lib/samtools.ts'

import type BAMFeature from '../src/record.ts'

const CORPUS = 'test/data/hts-specs-sam'
const files = readdirSync(CORPUS)
  .filter(f => f.endsWith('.sam.gz'))
  .sort()

const available = samtoolsAvailable()
const tmp = available ? mkdtempSync(join(tmpdir(), 'hts-specs-')) : ''
let recordCount = 0

afterAll(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true })
  }
})

function samtools(args: string[]) {
  return execFileSync('samtools', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// samtools prints floats with %g: six significant digits. toPrecision would
// turn -0 into 0, and the corpus checks that -0 survives.
function float(x: number) {
  return Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(6)) : x
}

function parseFloatText(s: string) {
  const n = Number(s)
  if (!Number.isNaN(n)) {
    return n
  }
  const lower = s.toLowerCase()
  if (lower === 'inf' || lower === '+inf') {
    return Infinity
  }
  if (lower === '-inf') {
    return -Infinity
  }
  return NaN
}

// a tag as samtools prints it, and as this reader should have decoded it
function expectedTag(type: string, value: string): unknown {
  switch (type) {
    case 'i':
      return Number(value)
    case 'f':
      return float(parseFloatText(value))
    case 'B': {
      const [subtype, ...items] = value.split(',')
      return items.map(v =>
        subtype === 'f' ? float(parseFloatText(v)) : Number(v),
      )
    }
    default:
      return value
  }
}

// an unaligned B array decodes to a plain array, so the subtype comes from the
// text rather than from the array's class
function decodedTag(type: string, text: string, value: unknown): unknown {
  if (type === 'f') {
    return float(value as number)
  }
  if (type === 'B') {
    const values = Array.from(value as ArrayLike<number>)
    return text.startsWith('f,') ? values.map(float) : values
  }
  return value
}

function samLine(r: BAMFeature, refNames: string[]) {
  const rname = refNames[r.ref_id] ?? '*'
  const rnext =
    r.next_refid < 0
      ? '*'
      : r.next_refid === r.ref_id
        ? '='
        : refNames[r.next_refid]!
  return [
    r.name,
    r.flags,
    rname,
    r.start + 1,
    // mq reports SAM's "unavailable" as undefined
    r.mq ?? 255,
    r.CIGAR || '*',
    rnext,
    r.next_pos + 1,
    r.template_length,
    r.seq || '*',
    qualString(r.qual),
  ].join('\t')
}

describe.skipIf(!available)('hts-specs SAM conformance corpus', () => {
  test.each(files)('%s matches samtools', async name => {
    const sam = `${CORPUS}/${name}`
    const bam = join(tmp, name.replace(/\.sam\.gz$/, '.bam'))
    samtools(['view', '-b', '-o', bam, sam])
    const expected = samtools(['view', bam])
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('\t'))

    let refNames: string[] = []
    const records: BAMFeature[] = []
    for await (const batch of streamBamRecords({
      bamPath: bam,
      onHeader: h => {
        refNames = h.indexToChr.map(r => r.refName)
      },
    })) {
      records.push(...batch)
    }

    expect(records.length).toBe(expected.length)
    for (const [i, r] of records.entries()) {
      const fields = expected[i]!
      expect(samLine(r, refNames)).toBe(fields.slice(0, 11).join('\t'))

      const tags = fields.slice(11).map(t => {
        const [tag, type, ...rest] = t.split(':')
        return [tag!, type!, rest.join(':')] as const
      })
      expect(Object.keys(r.tags)).toEqual(tags.map(([tag]) => tag))
      for (const [tag, type, value] of tags) {
        expect(
          decodedTag(type, value, r.tags[tag]),
          `${r.name} ${tag}`,
        ).toEqual(expectedTag(type, value))
      }
    }
    recordCount += records.length
  })

  test('covers the whole corpus', () => {
    expect(files.length).toBe(82)
    expect(recordCount).toBe(316)
  })
})
