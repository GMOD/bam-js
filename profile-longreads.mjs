import BamFile from './esm/bamFile.js'

async function main() {
  console.log('Profiling long reads only (out.bam)...')
  const bam = new BamFile({
    bamPath: './test/data/out.bam',
    baiPath: './test/data/out.bam.bai',
  })
  await bam.getHeader()

  // Do many iterations to get good profiling data
  for (let i = 0; i < 50; i++) {
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
  console.log('Profiling complete')
}

main().catch(console.error)
