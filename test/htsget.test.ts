import fs from 'fs'
import zlib from 'zlib'

import { unzip } from '@gmod/bgzf-filehandle'
import { expect, test } from 'vitest'

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
 */
function mockFetch({
  rangeUrls = fixtureUrls().all,
  error,
}: { rangeUrls?: HtsgetUrl[]; error?: { status: number; body: string } } = {}) {
  const calls: Call[] = []
  const ticket = (urls: HtsgetUrl[]) =>
    error
      ? new Response(error.body, { status: error.status })
      : Response.json({ htsget: { urls } })

  const fetcher: Fetcher = async (input, init) => {
    const url = urlOf(input)
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    return url.startsWith('data:')
      ? fetch(url)
      : url.startsWith(ticketUrl)
        ? ticket(url.includes('class=header') ? fixtureUrls().all : rangeUrls)
        : url === blockUrl
          ? new Response(fs.readFileSync('test/htsget/data.bam'), {
              status: 206,
            })
          : new Response('unexpected url', { status: 404 })
  }
  return {
    calls,
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

test('the supplied fetch is used for ticket and data-block requests', async () => {
  const { fetcher, find } = mockFetch()
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
  expect(find(c => c.url === blockUrl).headers.authorization).toBe('Bearer tok')
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
  const fetcher: Fetcher = async input =>
    urlOf(input).startsWith(localUrl)
      ? new Response(fs.readFileSync(path), { status: 206 })
      : Response.json({
          htsget: {
            format: 'BAM',
            urls: [
              block(
                urlOf(input).includes('class=header') ? 'header' : undefined,
              ),
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

  const viaHtsget = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: async input =>
      urlOf(input).includes('class=header')
        ? Response.json({ htsget: { urls: [{ url: 'hdr' }] } })
        : urlOf(input).includes('referenceName')
          ? Response.json({ htsget: { urls: [{ url: 'body' }] } })
          : new Response(
              urlOf(input) === 'hdr' ? fs.readFileSync(path) : bodyOnly,
            ),
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

  const bam = new HtsgetFile({
    baseUrl,
    trackId,
    fetch: async input =>
      urlOf(input).includes('class=header')
        ? Response.json({ htsget: { urls: [{ url: 'hdr' }] } })
        : urlOf(input).includes('referenceName')
          ? Response.json({ htsget: { urls: [{ url: 'cut' }] } })
          : new Response(
              urlOf(input) === 'hdr' ? fs.readFileSync(path) : truncated,
            ),
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
