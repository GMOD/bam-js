import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it, vi } from 'vitest'

import { BamFile } from '../src/index.ts'

// Counts what a query actually pulls off disk, because over HTTP every one of
// these is a range request. The numbers here are the ones the README quotes.
class CountingFile extends LocalFile {
  reads: { position: number; length: number }[] = []

  override async read(length: number, position = 0) {
    const data = await super.read(length, position)
    this.reads.push({ position, length: data.length })
    return data
  }
}

const BAM = 'test/data/chr22_nanopore_subset.bam'
const REGION = ['22', 16300000, 16310000] as const

function openFiles() {
  const bam = new CountingFile(BAM)
  const bai = new CountingFile(`${BAM}.bai`)
  const readIndex = vi.spyOn(bai, 'readFile')
  return {
    bai,
    bam,
    file: new BamFile({ bamFilehandle: bam, baiFilehandle: bai }),
    readIndex,
  }
}

describe('what a query reads', () => {
  it('fetches the index whole, once, rather than as scattered reads of it', async () => {
    const { bai, file, readIndex } = openFiles()
    await file.getRecordsForRange(...REGION)
    await file.getRecordsForRange('22', 16400000, 16410000)

    expect(readIndex).toHaveBeenCalledTimes(1)
    expect(bai.reads).toEqual([])
  })

  it('reads the records as a handful of ranges spread through the file', async () => {
    const { bam, file } = openFiles()
    await file.getHeader()
    bam.reads = []

    const records = await file.getRecordsForRange(...REGION)
    expect(records).toHaveLength(8)
    expect(bam.reads).toHaveLength(6)

    // spread, not contiguous: chunk merging leaves gaps between the reads, and
    // closing those is what a byte-range cache underneath is for. the reads go
    // out concurrently, so order them by position before measuring the gaps
    const sorted = bam.reads.toSorted((a, b) => a.position - b.position)
    const gaps = sorted
      .slice(1)
      .map((r, i) => r.position - (sorted[i]!.position + sorted[i]!.length))
    expect(gaps.every(gap => gap > 0)).toBe(true)
  })
})
