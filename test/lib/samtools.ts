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
