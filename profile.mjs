import BamFile from './esm/bamFile.js'

async function profileShortReads() {
  console.log('Profiling short reads (volvox-sorted.bam)...')
  const bam = new BamFile({
    bamPath: './test/data/volvox-sorted.bam',
    baiPath: './test/data/volvox-sorted.bam.bai',
  })
  await bam.getHeader()

  // Do multiple iterations to get a good sample
  for (let i = 0; i < 100; i++) {
    const records = await bam.getRecordsForRange('ctgA', 1, 50000)
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

async function profileLongReads() {
  console.log('Profiling long reads (out.bam)...')
  const bam = new BamFile({
    bamPath: './test/data/out.bam',
    baiPath: './test/data/out.bam.bai',
  })
  await bam.getHeader()

  // Do multiple iterations
  for (let i = 0; i < 20; i++) {
    const records = await bam.getRecordsForRange('1', 1, 100000)
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
  console.log('Long reads profiling complete')
}

async function main() {
  console.log('Starting profiling...')
  console.log('Run this with: node --cpu-prof profile.mjs')
  console.log('This will generate a .cpuprofile file that can be analyzed\n')

  await profileShortReads()
  await profileLongReads()

  console.log('\nProfiling complete!')
  console.log('Load the generated .cpuprofile file in Chrome DevTools:')
  console.log('1. Open Chrome and go to: chrome://inspect')
  console.log('2. Click "Open dedicated DevTools for Node"')
  console.log('3. Go to the "Profiler" tab')
  console.log('4. Click "Load" and select the .cpuprofile file')
}

main().catch(console.error)
