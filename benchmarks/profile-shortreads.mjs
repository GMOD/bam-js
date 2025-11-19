import BamFile from './esm/bamFile.js'

async function profileShortReads() {
  console.log('Profiling short reads (shortreads_300x.bam)...')
  const bam = new BamFile({
    bamPath: './test/data/shortreads_300x.bam',
    baiPath: './test/data/shortreads_300x.bam.bai',
  })
  await bam.getHeader()

  // Do multiple iterations to get a good sample
  for (let i = 0; i < 100; i++) {
    const records = await bam.getRecordsForRange('1', 197_745_515, 197_769_932)
    for (const record of records) {
      const _start = record.start
      const _end = record.end
      const _strand = record.strand
      const _name = record.name
      const _cigar = record.CIGAR
      const _seq = record.seq
      const _qual = record.qual
      const _tags = record.tags
    }
  }
  console.log('Short reads profiling complete')
}

async function main() {
  console.log('Starting profiling...')
  console.log('Run this with: node --cpu-prof profile.mjs')
  console.log('This will generate a .cpuprofile file that can be analyzed\n')

  await profileShortReads()
}

main().catch(console.error)
