import { BamFile } from './esm/index.js'

const bamPath = 'test/data/shortreads_300x.bam'
const refSeq = '1'
const startPosition = 197745369
const windowSize = 10000
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
