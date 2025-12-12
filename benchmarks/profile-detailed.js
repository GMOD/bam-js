import { BamFile } from './esm/index.js'

const bam = new BamFile({
  bamPath: 'test/data/shortreads_300x.bam',
})

await bam.getHeader()
// This file contains reads from chr1:197,745,515-197,769,932
const records = await bam.getRecordsForRange('1', 197_745_515, 197_769_932)

// Access various properties to trigger lazy decoding
let seqLen = 0
let tagCount = 0
let cigarOps = 0

for (const r of records) {
  // Access computed properties that trigger parsing
  seqLen += r.seq.length
  tagCount += Object.keys(r.tags).length
  cigarOps += r.CIGAR.length
  // Access other properties
  r.name
  r.qual
  r.end
}

console.log(`Processed ${records.length} records`)
console.log(`Total seq length: ${seqLen}`)
console.log(`Total tags: ${tagCount}`)
console.log(`Total CIGAR chars: ${cigarOps}`)
