import { expect, test } from 'vitest'

import BamRecord from '../src/record.ts'

// Build a minimal BAM alignment record (SAMv1.pdf §4.2) carrying a single 'B'
// (array) tag, with no read bases. Layout from the record start:
//   block_size i32 | refID i32 | pos i32 | bin_mq_nl i32 | flag_nc i32 |
//   l_seq i32 | next_refID i32 | next_pos i32 | tlen i32 |
//   read_name (l_read_name, null-terminated) | cigar | seq | qual | tags
function makeRecordWithBTag(
  tagName: string,
  subtype: number,
  writeValues: (dv: DataView, p: number) => number,
) {
  const readName = 'q\0'
  const lReadName = readName.length
  const fixedEnd = 36 + lReadName // no cigar, no seq, no qual
  // tag = name(2) + type(1) + subtype(1) + count(4) + payload
  const buf = new Uint8Array(256)
  const dv = new DataView(buf.buffer)

  dv.setInt32(4, 0, true) // refID
  dv.setInt32(8, 0, true) // pos
  dv.setInt32(12, lReadName, true) // bin_mq_nl: l_read_name in low byte
  dv.setInt32(16, 0, true) // flag_nc: 0 cigar ops, flags 0
  dv.setInt32(20, 0, true) // l_seq
  dv.setInt32(24, -1, true) // next_refID
  dv.setInt32(28, 0, true) // next_pos
  dv.setInt32(32, 0, true) // tlen
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0

  let p = fixedEnd
  buf[p++] = tagName.charCodeAt(0)
  buf[p++] = tagName.charCodeAt(1)
  buf[p++] = 0x42 // 'B'
  buf[p++] = subtype
  const end = writeValues(dv, p)

  dv.setInt32(0, end - 4, true) // block_size = bytes following this field
  return new BamRecord({
    bytes: { byteArray: buf, start: 0, end: end - 1 },
    fileOffset: 0,
    dataView: dv,
  })
}

test('B tag int32 array via tags and getTag', () => {
  const values = [10, 20, 30]
  const rec = makeRecordWithBTag('Bi', 0x69, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setInt32(p, v, true)
      p += 4
    }
    return p
  })
  expect([...(rec.tags.Bi as Int32Array | number[])]).toEqual(values)
  expect([...(rec.getTag('Bi') as Int32Array | number[])]).toEqual(values)
})

test('B tag float32 array', () => {
  const values = [1.5, -2.25, 3.75]
  const rec = makeRecordWithBTag('Bf', 0x66, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setFloat32(p, v, true)
      p += 4
    }
    return p
  })
  expect([...(rec.tags.Bf as Float32Array | number[])]).toEqual(values)
})

test('B tag uint8 array', () => {
  const values = [1, 2, 255]
  const rec = makeRecordWithBTag('Bc', 0x43, (dv, p) => {
    dv.setInt32(p, values.length, true)
    p += 4
    for (const v of values) {
      dv.setUint8(p, v)
      p += 1
    }
    return p
  })
  expect([...(rec.tags.Bc as Uint8Array)]).toEqual(values)
})

test('qual is returned for unmapped reads that carry bases', () => {
  const quals = [30, 40]
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true) // l_read_name = 2
  dv.setInt32(16, 0x4 << 16, true) // flag_nc: flag = BAM_FUNMAP, 0 cigar ops
  dv.setInt32(20, 2, true) // l_seq = 2
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0
  buf[38] = 0x12 // packed seq (2 bases)
  buf[39] = quals[0]!
  buf[40] = quals[1]!
  const rec = new BamRecord({
    bytes: { byteArray: buf, start: 0, end: 40 },
    fileOffset: 0,
    dataView: dv,
  })
  expect(rec.isSegmentUnmapped()).toBe(true)
  expect([...(rec.qual ?? [])]).toEqual(quals)
})

test('qual is null when there are no bases', () => {
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 2, true)
  dv.setInt32(20, 0, true) // l_seq = 0
  buf[36] = 'q'.charCodeAt(0)
  buf[37] = 0
  const rec = new BamRecord({
    bytes: { byteArray: buf, start: 0, end: 38 },
    fileOffset: 0,
    dataView: dv,
  })
  expect(rec.qual).toBeNull()
})

test('flags reads full uint16 without sign extension', () => {
  const buf = new Uint8Array(64)
  const dv = new DataView(buf.buffer)
  dv.setInt32(12, 1, true) // l_read_name = 1
  dv.setUint16(18, 0x8001, true) // flag with bit 15 set
  buf[36] = 0
  const rec = new BamRecord({
    bytes: { byteArray: buf, start: 0, end: 40 },
    fileOffset: 0,
    dataView: dv,
  })
  expect(rec.flags).toEqual(0x8001)
})
