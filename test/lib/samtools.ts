import { execFileSync } from 'node:child_process'

/**
 * Thin wrapper over the samtools CLI, used as the reference implementation the
 * reader is checked against.
 *
 * Coordinates: samtools regions are 1-based and inclusive on both ends, this
 * library's are 0-based and half-open, so `[min, max)` is `min+1`-`max`.
 */

export function samtoolsAvailable() {
  try {
    execFileSync('samtools', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function samtoolsVersion() {
  return execFileSync('samtools', ['--version'], { encoding: 'utf8' })
    .split('\n', 1)[0]!
    .trim()
}

function run(args: string[]) {
  return execFileSync('samtools', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // With REF_PATH unset, htslib falls back to fetching CRAM references
      // from the EBI registry over the network for any file whose UR path is
      // missing — which is every fixture here, since they carry the absolute
      // paths of whoever generated them. That turns a hermetic suite into a
      // slow and network-dependent one: it is what made long_pair.cram, whose
      // header names 3316 references, take minutes on CI and seconds locally,
      // where the lookup happens to fail fast.
      //
      // Point it at the fixtures instead. Anything genuinely needed is passed
      // explicitly with -T; anything else should fail immediately rather than
      // reach for the internet.
      REF_PATH: process.env.REF_PATH ?? 'test/data/%s',
    },
  })
}

export interface Ref {
  name: string
  length: number
  /** position in the header, which is the numeric id CRAM queries take */
  id: number
}

/**
 * References in header order, from the file itself rather than a fixture.
 *
 * Returns undefined when samtools will not read the file at all. Some fixtures
 * are deliberately malformed — large_coords.bam carries a header htslib rejects
 * — and those cannot be used to judge this reader against it.
 */
export function references(
  file: string,
  extra: string[] = [],
): Ref[] | undefined {
  let out: string
  try {
    out = run(['view', '-H', ...extra, file])
  } catch {
    return undefined
  }
  const refs: Ref[] = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('@SQ')) {
      continue
    }
    const name = /\tSN:([^\t]+)/.exec(line)?.[1]
    const length = /\tLN:(\d+)/.exec(line)?.[1]
    if (name && length) {
      refs.push({ name, length: Number(length), id: refs.length })
    }
  }
  return refs
}

/**
 * Which references actually hold records, read from the index.
 *
 * Headers can be far larger than the data: long_pair.cram declares 3316
 * references and puts records on one of them. Walking the header instead would
 * spend the whole run querying empty references.
 */
export function refsWithRecords(file: string) {
  const present = new Set<string>()
  let out: string
  try {
    out = run(['idxstats', file])
  } catch {
    return undefined
  }
  for (const line of out.split('\n')) {
    const [name, , mapped, unmapped] = line.split('\t')
    if (name && name !== '*' && Number(mapped) + Number(unmapped) > 0) {
      present.add(name)
    }
  }
  return present
}

/** `QNAME|FLAG|POS` for every record samtools reports in [min, max). */
export function records(
  file: string,
  ref: string,
  min: number,
  max: number,
  extra: string[] = [],
) {
  return run(['view', ...extra, file, `${ref}:${min + 1}-${max}`])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const f = line.split('\t')
      return `${f[0]}|${f[1]}|${f[3]}`
    })
}

/**
 * Every record samtools reports for a whole reference, as sorted
 * `QNAME FLAG POS CIGAR MAPQ TLEN SEQ QUAL` lines.
 *
 * {@link records} keys on identity alone, which is what a window comparison
 * needs: it asks whether the right reads came back. This asks the other
 * question — whether each one decoded to the same alignment — so it is worth
 * paying once per reference rather than once per window.
 */
export function alignments(
  file: string,
  ref: string,
  extra: string[] = [],
  opts: { scan?: boolean; dropTlen?: boolean } = {},
) {
  // `scan` reads the whole file and picks the reference out here rather than
  // asking samtools for a region. It is what makes an unsorted file
  // comparable: only htslib's *region iterator* assumes coordinate order, and
  // a linear read of the same file is still the right answer. See
  // sortedness().
  const args = opts.scan
    ? ['view', ...extra, file]
    : ['view', ...extra, file, ref]
  return run(args)
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(f => !opts.scan || f[2] === ref)
    .map(f =>
      // SAM column order is QNAME FLAG RNAME POS MAPQ CIGAR RNEXT PNEXT TLEN
      // SEQ QUAL; samFields wants the eight it compares, in its own order
      samFields(
        [f[0], f[1], f[3], f[5], f[4], f[8], f[9], f[10]],
        opts.dropTlen,
      ),
    )
    .sort()
}

/**
 * The eight fields above, in a spelling both sides can be built in.
 *
 * CIGAR is normalised first. SAM writes an absent one as `*`, and htslib prints
 * whatever CIGAR an unmapped record happens to store, where these readers
 * return none for one — an unmapped read has no alignment to describe. Blank it
 * on both sides rather than let that one deliberate divergence mask every other
 * CIGAR difference. It changes exactly one record in either corpus: paired.bam's
 * SRR062635.1831187 at 20:74230, FLAG 133, which carries 35M65S.
 *
 * `dropTlen` blanks the template length, for the one fixture where the two
 * implementations legitimately disagree — see its caller.
 */
export function samFields(
  f: (string | number | null | undefined)[],
  dropTlen = false,
) {
  const flags = Number(f[1])
  const cigar = flags & 0x4 ? '*' : f[3] || '*'
  const tlen = dropTlen ? '-' : f[5]
  return [f[0], flags, f[2], cigar, f[4], tlen, f[6] || '*', f[7]].join('\t')
}

/**
 * QUAL as samtools spells it.
 *
 * "No quality" is 0xff in every byte, and htslib decides on the first one
 * alone, so this does too. Either reader hands back the stored bytes, which is
 * the same answer in a different spelling.
 */
export function qualString(qual: Uint8Array | null | undefined) {
  if (!qual?.length || qual[0] === 0xff) {
    return '*'
  }
  let out = ''
  for (const q of qual) {
    out += String.fromCharCode(q + 33)
  }
  return out
}

export function count(
  file: string,
  ref: string,
  min: number,
  max: number,
  extra: string[] = [],
) {
  return Number(
    run(['view', '-c', ...extra, file, `${ref}:${min + 1}-${max}`]).trim(),
  )
}

/**
 * One pass over the whole file, ignoring the index, reporting per reference
 * whether its records appear in non-decreasing POS order.
 *
 * htslib's region iterator assumes coordinate order: it stops at the first
 * record past the query rather than scanning on. On a file that is not sorted
 * it therefore returns a prefix of the right answer, so samtools is not a
 * reference answer for that file. Several htslib fixtures are deliberately
 * grouped by template, or interleave two references, and exist to exercise
 * other things.
 *
 * Returns undefined when samtools will not decode the file — for CRAM that
 * means no reference, in which case the question cannot be asked.
 */
export function sortedness(file: string, extra: string[] = []) {
  let out: string
  try {
    out = run(['view', ...extra, file])
  } catch {
    return undefined
  }
  const sorted = new Map<string, boolean>()
  const previous = new Map<string, number>()
  for (const line of out.split('\n')) {
    if (!line) {
      continue
    }
    const fields = line.split('\t')
    const ref = fields[2]!
    const pos = Number(fields[3])
    if (pos < (previous.get(ref) ?? -1)) {
      sorted.set(ref, false)
    } else if (!sorted.has(ref)) {
      sorted.set(ref, true)
    }
    previous.set(ref, pos)
  }
  return sorted
}

/**
 * Windows that put a query edge exactly on a record edge, which is where
 * inclusive/exclusive mistakes live. For each sampled record we ask for the
 * window that should just barely contain it and the one that should just barely
 * miss it, at both ends.
 *
 * The comparison at each window is over the whole result set, so a probe built
 * from one record still checks every other record that window touches.
 */
export function boundaryWindows(
  spans: { start: number; end: number }[],
  refLength: number,
  samples = 6,
) {
  const windows: [number, number][] = [[0, refLength]]
  if (spans.length === 0) {
    return windows
  }
  const step = Math.max(1, Math.floor(spans.length / samples))
  const pad = 1000
  for (let i = 0; i < spans.length; i += step) {
    const { start, end } = spans[i]!
    const clamp = (n: number) => Math.max(0, Math.min(refLength, n))
    windows.push(
      // query starts on the record's last base: must contain it
      [clamp(end - 1), clamp(end - 1 + pad)],
      // query starts at the record's exclusive end: must not
      [clamp(end), clamp(end + pad)],
      // query ends on the record's first base: must contain it
      [clamp(start - pad), clamp(start + 1)],
      // query ends where the record starts: must not
      [clamp(start - pad), clamp(start)],
    )
  }
  return windows.filter(([lo, hi]) => hi > lo)
}
