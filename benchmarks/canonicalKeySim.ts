// Simulate cache-key strategies for the chunk feature cache, off the index
// alone — no reads, no decompression, no library change.
//
//   node --experimental-transform-types benchmarks/canonicalKeySim.ts
//
// ADR 0019 measures that `chunkCacheKey` is the MERGED chunk's span and the
// merge is query-dependent, so a pan re-parses bytes it already had. It sizes
// two strategies: the merged key we ship, and a raw-bin-chunk key that fixes
// the waste but explodes the entry count (6 -> 41, 14 -> 179 on long-read).
//
// This adds two more, and one of them works.
//
// CANONICAL — merge the refId's WHOLE chunk list once, with the same gap and
// span rules, into a partition that does not depend on any query. A query then
// selects which canonical chunks it overlaps rather than producing its own
// merge. The key is a canonical chunk's span: a property of the file and the
// index alone.
//
// GRID — leave the chunk list alone and round the query's own merged span
// OUTWARD to fixed boundaries taken from the linear index.
//
// WHAT IT SAYS, 10 windows of 19kb stepping 9.5kb, bytes fetched / cache
// entries, against `merged` which is what ships:
//
//   fixture            merged        raw          canonical (5MB)
//   20x.shortread      3.36 / 13     2.17 / 16    2.50 /  1
//   200x.shortread    23.39 / 13    11.14 / 16   13.94 /  3
//   1000x.shortread   49.64 / 18    49.42 / 17   64.80 / 18   <- the one loss
//   200x.longread     63.08 / 16    57.26 / 41   55.31 /  6
//   1000x.longread   291.74 / 60   278.97 / 179 269.27 / 14
//
// Three things follow.
//
// **Canonical retires the objection that parked ADR 0019.** The raw key's cost
// was the entry explosion — 41 and 179 entries where the merged key has 16 and
// 60, on the long-read files that gain nothing. Canonical has 6 and 14, i.e.
// FEWER entries than shipping today, because merging over the whole contig
// produces coarser units than a query's own merge does. It also fills exactly
// one cache entry per fetch, so `@gmod/shared-read-cache` needs no batch-fill
// path — which was the other half of why ADR 0019 is not a one-repo change.
//
// **It converges and the merged key does not.** Extending the pan from 10
// windows to 30, canonical does not move at all (13.94 MB on 200x.shortread,
// both) while merged grows 23.39 -> 32.11: every window mints a fresh key, so
// panning inside a region you have already read keeps costing. That is the
// property worth having, more than any single row above.
//
// **The loss is real and does not amortize.** On 1000x.shortread canonical
// fetches 64.80 MB against 60.16 at convergence, ~8% worse, because a canonical
// chunk there is bigger than the query's own and gets pulled whole. The span
// cap does NOT fix it — 0.25MB, 1MB and 5MB all give ~64.8 MB, because the
// partition can never be finer than the file's raw BAI chunks, which are
// already ~5MB at that depth. That fixture is also the one with almost no
// redundancy to win (2.3% measured live), so canonical is paying over-fetch for
// a saving that is not there.
//
// GRID is a dead end and is kept here so it is not re-proposed. At x1 the
// boundaries sit where the merged spans already start and end, so it is
// indistinguishable from today (49% saved either way on 20x); coarser grids
// over-fetch catastrophically (x16 is 1210 MB against 49 MB on 1000x.shortread)
// because a snapped span is charged over its whole width.

import { BamFile } from '../src/index.ts'
import Chunk from '../src/chunk.ts'
import { optimizeChunks } from '../src/util.ts'

const DATA = `${process.env.HOME}/src/jb2bench/data`

function arg(name: string, dflt: string) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const REFNAME = arg('refName', 'chr22_mask')
const START = Number(arg('start', '124000'))
const WIDTH = Number(arg('width', '19000'))
const STEP = Number(arg('step', '9500'))
const STEPS = Number(arg('steps', '10'))

const FIXTURES = arg(
  'files',
  '20x.shortread.bam,200x.shortread.bam,1000x.shortread.bam,200x.longread.bam,1000x.longread.bam',
).split(',')

function keyOf(c: Chunk) {
  return `${c.minv.blockPosition}:${c.minv.dataPosition}-${c.maxv.blockPosition}:${c.maxv.dataPosition}`
}

// The partition. Every chunk the refId's bins hold, merged once — so the
// result depends on the file and not on any query.
//
// The span cap is a parameter here rather than optimizeChunks' 5MB constant,
// because it is the whole trade: a bigger canonical chunk is fewer entries and
// more over-fetch when a query wants part of one. Gap stays at 65000, which
// ADR 0011 swept.
function canonicalPartition(
  binIndex: Record<number, Chunk[]>,
  spanCap: number,
) {
  const all: Chunk[] = []
  for (const chunks of Object.values(binIndex)) {
    for (const c of chunks) {
      all.push(c)
    }
  }
  if (all.length === 0) {
    return all
  }
  // no `lowest`: pruning by the linear index is a per-query selection, and
  // folding it in here is exactly what would make the partition query-dependent
  all.sort(
    (a, b) =>
      a.minv.blockPosition - b.minv.blockPosition ||
      a.minv.dataPosition - b.minv.dataPosition,
  )
  const out: Chunk[] = [all[0]!]
  let lastMin = all[0]!.minv.blockPosition
  let lastMax = all[0]!.maxv.blockPosition
  for (let i = 1; i < all.length; i++) {
    const c = all[i]!
    const cMin = c.minv.blockPosition
    const cMax = c.maxv.blockPosition
    if (cMin - lastMax < 65000 && cMax - lastMin < spanCap) {
      const last = out[out.length - 1]!
      const cmp = cMax - lastMax || c.maxv.dataPosition - last.maxv.dataPosition
      if (cmp > 0) {
        out[out.length - 1] = new Chunk(
          last.minv,
          c.maxv,
          last.bin,
          c.endPosition,
        )
        lastMax = cMax
      }
    } else {
      out.push(c)
      lastMin = cMin
      lastMax = cMax
    }
  }
  return out
}

// Which canonical chunks a query's chunks land in. Canonical chunks are sorted
// and disjoint; dedupe through a Set rather than pairwise, since one canonical
// chunk routinely covers several of the query's and they need not be adjacent.
function selectCanonical(canon: Chunk[], want: Chunk[]) {
  const seen = new Set<Chunk>()
  for (const w of want) {
    for (const c of canon) {
      const after = c.maxv.blockPosition < w.minv.blockPosition
      const before = c.minv.blockPosition > w.maxv.blockPosition
      if (!after && !before) {
        seen.add(c)
      }
    }
  }
  return [...seen]
}

// GRID: instead of partitioning the chunk list, round the query's own merged
// span OUTWARD to fixed boundaries. The boundaries are linear-index entries —
// virtual offsets the file already defines, every `g`th one — so they are a
// property of the index, uniform in genome space, and independent of any query.
//
// Correctness-wise this reads a SUPERSET of what the query needs and the
// position filter drops the rest, exactly as an over-merged chunk does today.
// The attraction over partitioning the chunk list is that granularity is a
// tunable rather than a consequence of how big the file's BAI chunks happen to
// be — which is what stops the partition arm from ever getting finer at 1000x.
function snapToGrid(
  want: Chunk[],
  lin: Float64Array,
  linData: Float64Array,
  g: number,
) {
  const seen = new Map<string, Chunk>()
  const n = lin.length
  for (const w of want) {
    // largest grid boundary at or below the chunk start
    let lo = 0
    for (let i = 0; i < n; i += g) {
      if (lin[i]! <= w.minv.blockPosition) {
        lo = i
      } else {
        break
      }
    }
    // smallest grid boundary strictly above the chunk end, else end of file
    let hi = -1
    for (let i = lo; i < n; i += g) {
      if (lin[i]! > w.maxv.blockPosition) {
        hi = i
        break
      }
    }
    const minv = { blockPosition: lin[lo]!, dataPosition: linData[lo]! }
    const maxv =
      hi >= 0
        ? { blockPosition: lin[hi]!, dataPosition: linData[hi]! }
        : {
            blockPosition: w.maxv.blockPosition,
            dataPosition: w.maxv.dataPosition,
          }
    const c = new Chunk(minv as any, maxv as any, w.bin, w.endPosition)
    seen.set(keyOf(c), c)
  }
  return [...seen.values()]
}

// The `lowest` prune blocksForRange applies before merging: drop chunks that
// end at or below the linear index's floor for this query.
function pruneByLowest(
  chunks: Chunk[],
  lowest: { blockPosition: number; dataPosition: number } | undefined,
) {
  if (!lowest) {
    return chunks
  }
  return chunks.filter(c => {
    const cmp =
      c.maxv.blockPosition - lowest.blockPosition ||
      c.maxv.dataPosition - lowest.dataPosition
    return cmp > 0
  })
}

interface Arm {
  bytes: number
  entries: Set<string>
  fetches: number
}
const mkArm = (): Arm => ({ bytes: 0, entries: new Set(), fetches: 0 })

function charge(arm: Arm, chunks: Chunk[]) {
  for (const c of chunks) {
    const k = keyOf(c)
    if (!arm.entries.has(k)) {
      arm.entries.add(k)
      arm.bytes += c.fetchedSize()
      arm.fetches++
    }
  }
}

// what a pan costs if nothing is ever reused — the denominator redundancy is
// measured against
function chargeCold(arm: Arm, chunks: Chunk[]) {
  for (const c of chunks) {
    arm.bytes += c.fetchedSize()
    arm.fetches++
  }
}

const mb = (n: number) => `${(n / 1e6).toFixed(2)} MB`

console.log(
  `pan: ${STEPS} windows of ${WIDTH}bp stepping ${STEP}bp from ${REFNAME}:${START}\n`,
)
console.log(
  'fixture                 arm          fetched     entries   redundant',
)
console.log(
  '--------------------------------------------------------------------',
)

for (const file of FIXTURES) {
  const path = `${DATA}/${file}`
  const bam = new BamFile({ bamPath: path, baiPath: `${path}.bai` })
  await bam.getHeader()
  const refId = (bam as any).chrToIndex?.[REFNAME]
  if (refId === undefined) {
    console.log(`${file}: no ${REFNAME}`)
    continue
  }
  const index = (bam as any).index
  const indexData = await index.parse({})
  const ba = indexData.indices(refId)
  if (!ba) {
    console.log(`${file}: no index for ${REFNAME}`)
    continue
  }

  const CAPS = [250_000, 1_000_000, 5_000_000]
  const canons = CAPS.map(c => canonicalPartition(ba.binIndex, c))

  const merged = mkArm()
  const raw = mkArm()
  const canonArms = CAPS.map(() => mkArm())
  const GRIDS = [1, 4, 16]
  const gridArms = GRIDS.map(() => mkArm())
  const cold = mkArm()

  for (let i = 0; i < STEPS; i++) {
    const min = START + i * STEP
    const max = min + WIDTH

    // exactly what blocksForRange does today
    const overlappingBins = (index as any).reg2bins(min, max)
    const rawChunks: Chunk[] = []
    for (const [s, e] of overlappingBins) {
      for (let bin = s; bin <= e; bin++) {
        const bc = ba.binIndex[bin]
        if (bc) {
          rawChunks.push(...bc)
        }
      }
    }
    const lowest = (index as any).getLowestChunk(ba, min)
    const mergedChunks = optimizeChunks(rawChunks.slice(), lowest)

    charge(merged, mergedChunks)
    chargeCold(cold, mergedChunks)
    // the raw arm keys on the pre-merge chunks — same prune, no merge
    charge(raw, pruneByLowest(rawChunks, lowest))
    for (let k = 0; k < CAPS.length; k++) {
      charge(canonArms[k]!, selectCanonical(canons[k]!, mergedChunks))
    }
    for (let k = 0; k < GRIDS.length; k++) {
      charge(
        gridArms[k]!,
        snapToGrid(
          mergedChunks,
          ba.linearBlockPositions,
          ba.linearDataPositions,
          GRIDS[k]!,
        ),
      )
    }
  }

  const row = (name: string, a: Arm) => {
    const red = cold.bytes > 0 ? (100 * (cold.bytes - a.bytes)) / cold.bytes : 0
    console.log(
      `${file.padEnd(23)} ${name.padEnd(11)} ${mb(a.bytes).padStart(9)} ${String(a.entries.size).padStart(9)} ${`${red.toFixed(0)}% saved`.padStart(11)}`,
    )
  }
  console.log(
    `${file.padEnd(23)} ${'cold'.padEnd(11)} ${mb(cold.bytes).padStart(9)} ${'-'.padStart(9)} ${'-'.padStart(11)}`,
  )
  row('merged*', merged)
  row('raw', raw)
  for (let k = 0; k < CAPS.length; k++) {
    row(`canon ${CAPS[k]! / 1e6}MB`, canonArms[k]!)
  }
  for (let k = 0; k < GRIDS.length; k++) {
    row(`grid x${GRIDS[k]}`, gridArms[k]!)
  }
  console.log(
    `${''.padEnd(23)} partition sizes: ${CAPS.map((c, k) => `${c / 1e6}MB->${canons[k]!.length}`).join('  ')}`,
  )
  console.log()
}

console.log('* merged is what ships today')
