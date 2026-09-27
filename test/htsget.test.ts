import fs from 'fs'
import zlib from 'zlib'

import { unzip } from '@gmod/bgzf-filehandle'
import { afterEach, expect, test } from 'vitest'

import { BamFile, BamRecord, HtsgetFile, MISMATCH_SUBST } from '../src/index.ts'
import { parseRefSeqs } from '../src/util.ts'

import type { Fetcher } from 'generic-filehandle2'

const baseUrl = 'https://htsnexus.rnd.dnanex.us/v1/reads'
const trackId = 'BroadHiSeqX_b37/NA12878'
const ticketUrl = `${baseUrl}/${trackId}`
const blockUrl =
  'https://dl.dnanex.us/F/D/Pb1QjgQx9j2bZ8Q44x50xf4fQV3YZBgkvkz23FFB/NA12878_recompressed.bam'

interface HtsgetUrl {
  url: string
  headers?: Record<string, string>
  class?: 'header' | 'body'
}

// header block, body block and EOF block of the dnanexus 1:2000000-2000001
// ticket, in the order the server returned them
function fixtureUrls() {
  const ticket: { htsget: { urls: HtsgetUrl[] } } = JSON.parse(
    fs.readFileSync('test/htsget/result.json', 'utf8'),
  )
  const [header, body, eof] = ticket.htsget.urls
  if (!header || !body || !eof) {
    throw new Error('bad fixture')
  }
  return { header, body, eof, all: ticket.htsget.urls }
}

interface Call {
  url: string
  headers: Record<string, string>
}

function urlOf(input: Parameters<Fetcher>[0]) {
  return typeof input === 'string' ? input : input.url
}

/**
 * Serves the dnanexus fixtures and records every request. The class=header
 * ticket always gets the fixture as-is; rangeUrls lets a test reshape the
 * region ticket. base64 data: urls fall through to the real fetch so they
 * decode for real.
 *
 * Two halves, because HtsgetFile fetches them with two different functions: the
 * ticket goes through the `fetch` option, and data blocks go through the global
 * fetch so the option's credentials cannot reach them. Both record into the
 * same `calls`, and `blockCalls` is the half a credential must never appear in.
 */
function mockFetch({
  rangeUrls = fixtureUrls().all,
  error,
}: { rangeUrls?: HtsgetUrl[]; error?: { status: number; body: string } } = {}) {
  const calls: Call[] = []
  const blockCalls: Call[] = []
  const ticket = (urls: HtsgetUrl[]) =>
    error
      ? new Response(error.body, { status: error.status })
      : Response.json({ htsget: { urls } })

  const record = (
    into: Call[],
    input: Parameters<Fetcher>[0],
    init?: RequestInit,
  ) => {
    const url = urlOf(input)
    const call = {
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    }
    calls.push(call)
    if (into !== calls) {
      into.push(call)
    }
    return url
  }

  const fetcher: Fetcher = async (input, init) => {
    const url = record(calls, input, init)
    return ticket(url.includes('class=header') ? fixtureUrls().all : rangeUrls)
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (
    input: Parameters<Fetcher>[0],
    init?: RequestInit,
  ) => {
    const url = urlOf(input)
    // the wasm bgzf module loads itself through fetch(<data url>), so anything
    // this mock does not own has to reach the real one
    if (!url.startsWith(blockUrl) && !url.startsWith('data:')) {
      return realFetch(input, init)
    }
    if (url.startsWith('data:')) {
      return realFetch(url)
    }
    record(blockCalls, input, init)
    return new Response(fs.readFileSync('test/htsget/data.bam'), {
      status: 206,
    })
  }) as typeof fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  return {
    calls,
    blockCalls,
    fetcher,
    find: (pred: (c: Call) => boolean) => {
      const call = calls.find(pred)
      if (!call) {
        throw new Error('no matching request was made')
      }
      return call
    },
  }
}

/**
 * Serves data-block urls, which HtsgetFile now fetches with the global fetch
 * rather than the `fetch` option. Anything the map does not name — the wasm
 * bgzf module's own `fetch(<data url>)` above all — reaches the real fetch.
 */
function stubBlocks(bodies: Record<string, BodyInit>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (
    input: Parameters<Fetcher>[0],
    init?: RequestInit,
  ) => {
    const url = urlOf(input)
    const body = bodies[url]
    return body === undefined ? realFetch(input, init) : new Response(body)
  }) as typeof fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
}

test('reads a header and a region through the ticket', async () => {
  const { calls, fetcher, find } = mockFetch()
  const bam = new HtsgetFile({ baseUrl, trackId, fetch: fetcher })

  expect(await bam.getHeader()).toBeTruthy()
  expect((await bam.getRecordsForRange('1', 2000000, 2000001)).length).toBe(39)

  // format is the only parameter allowed alongside class=header
  expect(calls[0]?.url).toBe(`${ticketUrl}?class=header&format=BAM`)
  expect(
    find(c => c.url.startsWith(`${ticketUrl}?referenceName=1`)),
  ).toBeTruthy()
})

// An htsget stream has no file positions, so a record's id is a hash of its
// bytes; callers deduplicate on it, so a colliding pair loses a read
test('an htsget record id is a distinct safe integer, the same on every query', async () => {
  const { fetcher } = mockFetch()
  const ids = async () =>
    (
      await new HtsgetFile({
        baseUrl,
        trackId,
        fetch: fetcher,
      }).getRecordsForRange('1', 2000000, 2000001)
    ).map(r => r.fileOffset)
  const first = await ids()
  expect(first.every(id => Number.isSafeInteger(id))).toBe(true)
  expect(new Set(first).size).toBe(first.length)
  expect(await ids()).toEqual(first)
})

// The spec's "HTTPS data block URLs" rule 6: a block carries its own
// credential, in its url or in the ticket's `headers` for it, and the client
// "must not send the bearer token used for the API, if any, to the data block
// endpoint". A ticket names any host it likes, so the supplied fetch reaching a
// block url is one endpoint's token going wherever that ticket points. This
// used to assert the opposite.
test('the supplied fetch reaches the ticket and never a data block', async () => {
  const { fetcher, find, blockCalls } = mockFetch()
  const bam = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', 'Bearer tok')
      return fetcher(input, { ...init, headers })
    },
  })
  await bam.getRecordsForRange('1', 2000000, 2000001)

  expect(find(c => c.url.startsWith(ticketUrl)).headers.authorization).toBe(
    'Bearer tok',
  )
  expect(blockCalls.map(c => c.url)).toContain(blockUrl)
  expect(blockCalls.every(c => c.headers.authorization === undefined)).toBe(
    true,
  )
})

test('applies the ticket-supplied headers, minus referer', async () => {
  const { fetcher, find } = mockFetch()
  await new HtsgetFile({ baseUrl, trackId, fetch: fetcher }).getRecordsForRange(
    '1',
    2000000,
    2000001,
  )

  const block = find(c => c.url === blockUrl)
  expect(block.headers.range).toBe('bytes=104394370-104661190')
  expect(block.headers.referer).toBeUndefined()
})

// htsget-rs (the GA4GH reference implementation) does not split the header into
// its own block: a region ticket is a single url whose byte range starts at 0,
// so header and records arrive together and there is nothing to drop. The
// ticket below is the verbatim shape it serves. To check against the real
// thing:
//
//   docker run --rm -p 8080:8080 -p 8081:8081 \
//     -v $PWD/test/data/volvox-sorted.bam:/volvox-sorted.bam:ro \
//     -v $PWD/test/data/volvox-sorted.bam.bai:/volvox-sorted.bam.bai:ro \
//     ghcr.io/umccr/htsget-rs:latest
test('reads a ticket whose single block includes the header', async () => {
  const path = 'test/data/volvox-sorted.bam'
  const localUrl = 'http://localhost:8081/volvox-sorted.bam'
  const block = (cls?: 'header') => ({
    url: localUrl,
    headers: { Range: 'bytes=0-395272' },
    class: cls,
  })
  stubBlocks({ [localUrl]: fs.readFileSync(path) })
  const fetcher: Fetcher = async input =>
    Response.json({
      htsget: {
        format: 'BAM',
        urls: [
          block(urlOf(input).includes('class=header') ? 'header' : undefined),
        ],
      },
    })

  const viaHtsget = new HtsgetFile({
    baseUrl: 'http://localhost:8080/reads',
    trackId: 'volvox-sorted',
    fetch: fetcher,
  })
  const direct = new BamFile({ bamPath: path })
  await direct.getHeader()

  const records = await viaHtsget.getRecordsForRange('ctgA', 1000, 2000)
  const expected = await direct.getRecordsForRange('ctgA', 1000, 2000)
  expect(records.length).toBe(217)
  expect(records.map(r => `${r.name}/${r.start}/${r.end}/${r.ref_id}`)).toEqual(
    expected.map(r => `${r.name}/${r.start}/${r.end}/${r.ref_id}`),
  )
  // the shared header parse also populates the header text, which the htsget
  // path used to leave undefined
  expect(await viaHtsget.getHeaderText()).toBe(await direct.getHeaderText())
})

test('surfaces the htsget error type on a failed ticket request', async () => {
  const { fetcher } = mockFetch({
    error: {
      status: 401,
      body: JSON.stringify({
        htsget: {
          error: 'InvalidAuthentication',
          message: 'no token supplied',
        },
      }),
    },
  })
  const bam = new HtsgetFile({ baseUrl, trackId, fetch: fetcher })

  await expect(bam.getHeader()).rejects.toThrow(
    /HTTP 401 .*InvalidAuthentication: no token supplied/,
  )
})

// A ticket whose data blocks carry records only. The spec leaves it to the
// server whether the header is its own block, so recordsOffset seeks past a
// header when there is one and starts at 0 when there isn't — this is the
// second case, which no fixture covered.
test('reads a ticket whose blocks carry no header', async () => {
  const path = 'test/data/volvox-sorted.bam'
  const raw = await unzip(new Uint8Array(fs.readFileSync(path)))
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const headerEnd = parseRefSeqs(raw, 8 + dv.getInt32(4, true), n => n)!.end
  // re-compressed records with the header sliced off, i.e. what a server
  // serving body-only blocks returns
  const bodyOnly = new Uint8Array(
    zlib.gzipSync(Buffer.from(raw.subarray(headerEnd))),
  )

  stubBlocks({ hdr: fs.readFileSync(path), body: bodyOnly })
  const viaHtsget = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: async input =>
      Response.json({
        htsget: {
          urls: [
            { url: urlOf(input).includes('class=header') ? 'hdr' : 'body' },
          ],
        },
      }),
  })
  const direct = new BamFile({ bamPath: path })
  await direct.getHeader()

  const records = await viaHtsget.getRecordsForRange('ctgA', 1000, 2000)
  const expected = await direct.getRecordsForRange('ctgA', 1000, 2000)
  expect(records.length).toBe(expected.length)
  expect(records.map(r => `${r.name}/${r.start}/${r.end}`)).toEqual(
    expected.map(r => `${r.name}/${r.start}/${r.end}`),
  )
})

test('a ticket cut off inside the BAM header is reported, not parsed', async () => {
  const path = 'test/data/volvox-sorted.bam'
  const raw = await unzip(new Uint8Array(fs.readFileSync(path)))
  // magic and l_text survive, the ref-seq table does not. Parsing on would
  // read alignment records out of the middle of the header.
  const truncated = new Uint8Array(
    zlib.gzipSync(Buffer.from(raw.subarray(0, 20))),
  )

  stubBlocks({ hdr: fs.readFileSync(path), cut: truncated })
  const bam = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: async input =>
      Response.json({
        htsget: {
          urls: [
            { url: urlOf(input).includes('class=header') ? 'hdr' : 'cut' },
          ],
        },
      }),
  })

  await expect(bam.getRecordsForRange('ctgA', 1000, 2000)).rejects.toThrow(
    /truncated BAM header in htsget response/,
  )
})

// BamFile has an htsget mode, but it is only half of one: HtsgetFile overrides
// the header and query paths. Constructed directly it has no index and no
// filehandle, so it must say so rather than answer every query with zero
// records — which is what it did before the guard, since getSeqId found no
// chrToIndex and returned undefined.
test('BamFile in htsget mode without HtsgetFile fails loudly', async () => {
  const bam = new BamFile({ htsget: true })
  await expect(bam.getHeader()).rejects.toThrow(
    /no index to read a header from/,
  )
})

// Matches BamFile.getRecordsForRange, which returns [] for a name the header
// doesn't carry rather than requesting a region the server would reject.
test('an unknown reference name yields no records and no request', async () => {
  const { calls, fetcher } = mockFetch()
  const bam = new HtsgetFile({ baseUrl, trackId, fetch: fetcher })
  await bam.getHeader()
  const ticketsBefore = calls.length

  expect(await bam.getRecordsForRange('nonexistent', 0, 1000)).toEqual([])
  expect(calls.length).toBe(ticketsBefore)
})

// Mismatch resolution is BamFile's, but htsget overrides the query path it
// hangs off, so it needs its own check that reads with no MD get a reference.
// The dnanexus fixture's reads all carry one, so this hides it.
class NoMDRecord extends BamRecord {
  override get NUMERIC_MD() {
    return undefined
  }
}

test('reads with no MD are resolved against a fetched reference', async () => {
  const { fetcher } = mockFetch()
  const asked: [string, number, number][] = []
  const bam = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: fetcher,
    recordClass: NoMDRecord,
    fetchReferenceSequence: async (refName, start, end) => {
      asked.push([refName, start, end])
      return 'A'.repeat(end - start)
    },
  })
  const records = await bam.getRecordsForRange('1', 2000000, 2000001)
  expect(records.length).toBe(39)
  expect(asked).toHaveLength(1)
  expect(asked[0]![0]).toBe('1')

  // an all-A reference, so every non-A base of every read is a substitution
  const record = records[0]!
  expect(record.reference).toBeDefined()
  const substitutions = record
    .getMismatches()
    .filter(m => m.code === MISMATCH_SUBST)
  expect(substitutions.length).toBeGreaterThan(0)
  for (const m of substitutions) {
    expect(m.bases).not.toBe('A')
    expect(String.fromCharCode(m.refBaseCode)).toBe('A')
  }
})

// The spec takes GET parameters URL-encoded ("receive either URL-encoded query
// string parameters (GET)"). Interpolated raw, a PanSN contig name — the HPRC
// convention, sample#haplotype#contig — ended the query at its first "#", so the
// server saw referenceName=HG002 and no range at all, and answered a different
// question instead of erroring.
test('a refName with url-significant characters is encoded', async () => {
  const { fetcher, find } = mockFetch()
  const bam = new HtsgetFile({ baseUrl, trackId, fetch: fetcher })
  // the header gate runs first and would return [] for a name it doesn't carry;
  // it memoizes, so naming the contig after it is what gets a ticket requested
  await bam.getHeader()
  ;(bam as unknown as { chrToIndex: Record<string, number> }).chrToIndex = {
    'HG002#1#chr1': 0,
  }

  await bam.getRecordsForRange('HG002#1#chr1', 100, 200)

  const url = new URL(find(c => c.url.includes('referenceName')).url)
  expect(url.searchParams.get('referenceName')).toBe('HG002#1#chr1')
  expect(url.searchParams.get('start')).toBe('100')
  expect(url.searchParams.get('end')).toBe('200')
})

// The id "format ... is left to the discretion of the API provider, including
// allowing embedded '/' characters", and the spec's own examples start with one
// ("/byStudy/PRJEB4019"). An endpoint is as often written with a trailing slash
// as without. Concatenating raw produced "//" for either.
test.each([
  ['https://h/reads', 'NA12878'],
  ['https://h/reads/', 'NA12878'],
  ['https://h/reads', '/byStudy/PRJEB4019'],
  ['https://h/reads/', '/byStudy/PRJEB4019'],
])('joins %s and %s with one slash', async (base, id) => {
  const seen: string[] = []
  await new HtsgetFile({
    baseUrl: base,
    trackId: id,
    fetch: async input => {
      seen.push(urlOf(input))
      return Response.json({ htsget: { urls: [] } })
    },
  })
    .getHeader()
    .catch(() => undefined)

  expect(seen[0]).toBe(
    `${base.replace(/\/$/, '')}${id.startsWith('/') ? id : `/${id}`}?class=header&format=BAM`,
  )
})
