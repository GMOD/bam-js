// The index-free whole-file walk.
//
// What it has to get right is not the record decode — that is the same parser
// the indexed path uses and is pinned in record.test.ts — but the two carries.
// A window boundary lands wherever it lands, so it cuts BGZF blocks in half and
// BAM records in half, and the tests below run windows small enough to make
// both happen many times over one fixture.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { unzip } from '@gmod/bgzf-filehandle'
import { describe, expect, test } from 'vitest'

import { BamFile, streamBamRecords } from '../src/index.ts'

import type { BamStreamHeader } from '../src/index.ts'
import type { BgzfBlockInfo } from '@gmod/bgzf-filehandle'

const namesorted = 'test/data/paired-region.namesorted.bam'
const nanopore = 'test/data/ecoli_nanopore.bam'

function samtoolsAvailable() {
  try {
    execFileSync('samtools', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** `QNAME|FLAG|POS` for every record in the file, in file order */
function samtoolsIdentities(file: string) {
  return execFileSync('samtools', ['view', file], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  })
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const f = line.split('\t')
      return `${f[0]}|${f[1]}|${f[3]}`
    })
}

async function collect(opts: Parameters<typeof streamBamRecords>[0]) {
  const batches = []
  for await (const batch of streamBamRecords(opts)) {
    batches.push(batch)
  }
  return batches
}

function identities(
  batches: { name: string; flags: number; start: number }[][],
) {
  return batches.flat().map(r => `${r.name}|${r.flags}|${r.start + 1}`)
}

test('reads every record of a name-sorted BAM with no index', async () => {
  let header: BamStreamHeader | undefined
  const batches = await collect({
    bamPath: namesorted,
    onHeader: h => {
      header = h
    },
  })
  const records = batches.flat()

  expect(records.length).toBe(108)
  expect(header?.indexToChr).toStrictEqual([
    { refName: '20', length: 63025520 },
  ])
  // null-prototype, as parseRefSeqs builds it, so compare the entries
  expect(Object.entries(header!.chrToIndex)).toStrictEqual([['20', 0]])
  expect(header?.headerText.startsWith('@HD\tVN:1.')).toBe(true)
  expect(header?.samHeader.find(l => l.tag === 'HD')?.data).toContainEqual({
    tag: 'SO',
    value: 'queryname',
  })

  // name-sorted, so consecutive records are mate pairs and the coordinates run
  // backwards and forwards. This is exactly what no index can address.
  expect(records[0]!.name).toBe(records[1]!.name)
  expect(
    records.map(r => r.start).every((s, i, a) => i === 0 || s >= a[i - 1]!),
  ).toBe(false)
})

test('the header fires once, before the first batch', async () => {
  const order: string[] = []
  for await (const batch of streamBamRecords({
    bamPath: namesorted,
    onHeader: () => {
      order.push('header')
    },
  })) {
    order.push(`batch:${batch.length}`)
  }
  expect(order[0]).toBe('header')
  expect(order.filter(o => o === 'header').length).toBe(1)
})

test('records carried across window boundaries decode identically', async () => {
  const whole = identities(await collect({ bamPath: nanopore }))

  // one window per BGZF block, so nearly every window ends mid-record and the
  // record carry is exercised on almost every iteration
  const perBlock = await collect({ bamPath: nanopore, windowSize: 1 })
  expect(perBlock.length).toBeGreaterThan(10)
  expect(identities(perBlock)).toStrictEqual(whole)

  // a window size that is not a multiple of the block size, so the block carry
  // is a different length every time
  const ragged = await collect({ bamPath: nanopore, windowSize: 100_001 })
  expect(identities(ragged)).toStrictEqual(whole)
})

test('agrees with the indexed reader over a whole reference', async () => {
  const streamed = identities(await collect({ bamPath: nanopore }))
  const bam = new BamFile({ bamPath: nanopore })
  const header = await bam.getHeader()
  expect(header).toBeTruthy()
  const indexed = await bam.getRecordsForRange('ref000001|chr', 0, 5_000_000)
  expect(streamed.length).toBe(indexed.length)
  expect([...streamed].sort()).toStrictEqual(
    indexed.map(r => `${r.name}|${r.flags}|${r.start + 1}`).sort(),
  )
})

describe('fileOffset', () => {
  test('is unique even for byte-identical records', async () => {
    // exact_duplicate.bam holds the same alignment twice, which is what a
    // content hash cannot tell apart
    const records = (
      await collect({ bamPath: 'test/data/exact_duplicate.bam' })
    ).flat()
    expect(records.length).toBe(2)
    expect(records[0]!.name).toBe(records[1]!.name)
    expect(records[0]!.fileOffset).not.toBe(records[1]!.fileOffset)
  })

  test('does not depend on where the windows fell', async () => {
    const offsets = async (windowSize?: number) =>
      (await collect({ bamPath: nanopore, windowSize }))
        .flat()
        .map(r => r.fileOffset)
    const whole = await offsets()
    expect(new Set(whole).size).toBe(whole.length)
    expect(await offsets(1)).toStrictEqual(whole)
    expect(await offsets(100_001)).toStrictEqual(whole)
  })
})

test('inflates through a worker pool when given one', async () => {
  // node has no workers, so stand in for one: the pool contract is "inflate
  // these blocks, hand them back individually", which is what makes the
  // parallel path assemble to the same bytes as the sequential one
  const calls: number[] = []
  const pool = {
    async decompressBlocks(input: Uint8Array, blocks: BgzfBlockInfo[]) {
      calls.push(blocks.length)
      return {
        blocks: await Promise.all(
          blocks.map(b =>
            unzip(
              input.subarray(b.inputOffset, b.inputOffset + b.compressedSize),
            ),
          ),
        ),
      }
    },
    destroy() {
      /* nothing to tear down */
    },
  }

  const expected = identities(await collect({ bamPath: nanopore }))
  const pooled = await collect({ bamPath: nanopore, bgzfWorkerPool: pool })
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(n => n > 1)).toBe(true)
  expect(identities(pooled)).toStrictEqual(expected)

  // a promise, as getSharedWorkerPool() hands back — including its undefined,
  // which has to fall through to inflating in process rather than throwing
  expect(
    identities(
      await collect({
        bamPath: nanopore,
        bgzfWorkerPool: Promise.resolve(undefined),
      }),
    ),
  ).toStrictEqual(expected)
})

describe('readAhead', () => {
  /** a filehandle that records how many reads were outstanding at once */
  function countingFilehandle(path: string) {
    const buf = readFileSync(path)
    const state = { inFlight: 0, maxInFlight: 0, reads: 0 }
    const fh = {
      read: async (length: number, position: number) => {
        state.reads++
        state.inFlight++
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        // a turn of the event loop, so overlapping reads can be seen to overlap
        await new Promise(r => setTimeout(r, 1))
        state.inFlight--
        return buf.subarray(position, position + length)
      },
      readFile: async () => buf,
      stat: async () => ({ size: buf.length }),
    } as unknown as NonNullable<
      Parameters<typeof streamBamRecords>[0]['bamFilehandle']
    >
    return { fh, state }
  }

  test('keeps several reads in flight, and one when told to', async () => {
    const deep = countingFilehandle(nanopore)
    const flat = countingFilehandle(nanopore)
    const expected = identities(await collect({ bamPath: nanopore }))

    expect(
      identities(
        await collect({
          bamFilehandle: deep.fh,
          windowSize: 1,
          readAhead: 4,
        }),
      ),
    ).toStrictEqual(expected)
    expect(deep.state.maxInFlight).toBe(4)

    expect(
      identities(
        await collect({
          bamFilehandle: flat.fh,
          windowSize: 1,
          readAhead: 1,
        }),
      ),
    ).toStrictEqual(expected)
    expect(flat.state.maxInFlight).toBe(1)

    // depth costs at most depth-1 reads past the end, since a read's length is
    // the only thing that says the file has ended
    expect(deep.state.reads - flat.state.reads).toBeLessThanOrEqual(3)
  })

  test('a file inside one window costs exactly one read', async () => {
    // the depth must not open up before a read has come back full-length, or a
    // small remote BAM is four requests with three 416s
    const small = countingFilehandle(namesorted)
    await collect({ bamFilehandle: small.fh, readAhead: 4 })
    expect(small.state.reads).toBe(1)
  })

  test('a depth below one still makes progress', async () => {
    expect(
      identities(await collect({ bamPath: nanopore, readAhead: 0 })),
    ).toStrictEqual(identities(await collect({ bamPath: nanopore })))
  })
})

/** the smallest filehandle streamBamRecords needs, over a fixed buffer */
function bufferFilehandle(buf: Uint8Array) {
  return {
    read: async (length: number, position: number) =>
      buf.subarray(position, position + length),
    readFile: async () => buf,
    stat: async () => ({ size: buf.length }),
  } as unknown as NonNullable<
    Parameters<typeof streamBamRecords>[0]['bamFilehandle']
  >
}

describe('truncation', () => {
  test('a partial BGZF block at the end is an error', async () => {
    const whole = readFileSync(namesorted)
    await expect(
      collect({ bamFilehandle: bufferFilehandle(whole.subarray(0, 8000)) }),
    ).rejects.toThrow(/not a complete BGZF block/)
  })

  test('a header cut short is an error', async () => {
    // the first block alone, which holds the header but no complete ref-seq
    // table for the fixture's contig
    const whole = readFileSync(namesorted)
    await expect(
      collect({ bamFilehandle: bufferFilehandle(whole.subarray(0, 30)) }),
    ).rejects.toThrow(/not a BGZF stream|Insufficient data/)
  })
})

test('rejects a source that is not a BAM', async () => {
  await expect(
    collect({ bamPath: 'test/data/1000genomes_hg00096_chr1.bam.bai' }),
  ).rejects.toThrow(/not a BGZF stream|not a BAM file/)
})

test('rejects an empty source', async () => {
  await expect(
    collect({ bamPath: 'test/data/empty.bam.bai' }),
  ).rejects.toThrow()
})

test('needs a source', async () => {
  await expect(collect({})).rejects.toThrow(/no bam source/)
})

test('stops at an abort', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    collect({ bamPath: nanopore, signal: controller.signal }),
  ).rejects.toThrow()
})

describe.skipIf(!samtoolsAvailable())('samtools agreement', () => {
  test.each([namesorted, nanopore])(
    'streams %s in the same order samtools does',
    async file => {
      expect(
        identities(await collect({ bamPath: file, windowSize: 1 })),
      ).toStrictEqual(samtoolsIdentities(file))
    },
    60_000,
  )
})
