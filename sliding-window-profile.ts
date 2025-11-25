import { BamFile } from './esm/index.js'

const bamPath = 'test/data/chr22_nanopore_subset.bam'
const refSeq = '22'
const startPosition = 16560000
const windowSize = 1000
const numWindows = 5

async function run() {
  const bam = new BamFile({ bamPath })
  await bam.getHeader()
  for (let i = 0; i < numWindows; i++) {
    const start = startPosition + i * windowSize
    const end = start + windowSize
    await bam.getRecordsForRange(refSeq, start, end)
  }
}

run()
