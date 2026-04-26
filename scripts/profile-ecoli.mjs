import { BamFile } from '../esm/index.js'

async function time(label, fn, iterations) {
  // warmup
  for (let i = 0; i < 5; i++) {
    await fn()
  }
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    await fn()
  }
  const ms = performance.now() - start
  console.log(
    `${label}: ${iterations} iters, ${ms.toFixed(0)}ms total, ${(ms / iterations).toFixed(2)}ms/iter`,
  )
  return ms
}

const bamPath = 'test/data/ecoli_nanopore.bam'
const ref = 'ref000001|chr'

// --- header/index parsing (what the benchmark actually measures) ---
await time(
  'header+index parse (new BamFile each time)',
  async () => {
    const bam = new BamFile({ bamPath })
    await bam.getHeader()
  },
  200,
)

// --- single shared BamFile: record construction + filtering ---
{
  const bam = new BamFile({ bamPath })
  await bam.getHeader()
  const records = await bam.getRecordsForRange(ref, 0, 5000000)
  console.log(`\nrecords in region: ${records.length}`)
  if (records[0]) {
    const r = records[0]
    console.log(
      `sample: start=${r.start} end=${r.end} cigar_ops=${r.NUMERIC_CIGAR.length} seq_length=${r.seq_length}`,
    )
  }

  await time(
    'getRecordsForRange (cached header)',
    async () => {
      await bam.getRecordsForRange(ref, 0, 5000000)
    },
    200,
  )

  // --- access properties that were hot in old vs new code ---
  await time(
    'getRecordsForRange + end+NUMERIC_CIGAR (cached chunks)',
    async () => {
      const recs = await bam.getRecordsForRange(ref, 0, 5000000)
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i]
        void r.end
        void r.NUMERIC_CIGAR
      }
    },
    100,
  )

  // cold cache: clear between each iteration so records are re-parsed from raw bytes
  await time(
    'getRecordsForRange + end+NUMERIC_CIGAR (cold cache)',
    async () => {
      bam.clearFeatureCache()
      const recs = await bam.getRecordsForRange(ref, 0, 5000000)
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i]
        void r.end
        void r.NUMERIC_CIGAR
      }
    },
    100,
  )

  await time(
    'getRecordsForRange + end only (cold cache)',
    async () => {
      bam.clearFeatureCache()
      const recs = await bam.getRecordsForRange(ref, 0, 5000000)
      for (let i = 0; i < recs.length; i++) {
        void recs[i].end
      }
    },
    100,
  )
}
