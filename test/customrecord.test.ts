import { expect, test } from 'vitest'

import { BamFile, BamRecord } from '../src/index.ts'

import type {
  BamRecordLike,
  BamRecordConstructorArgs,
} from '../src/index.ts'

class CustomBamRecord extends BamRecord implements BamRecordLike {
  customProp = 'custom'

  get customMethod() {
    return `${this.name}-custom`
  }

  get isHighQuality() {
    return (this.mq ?? 0) > 30
  }
}

test('can use custom record factory', async () => {
  const bamFile = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    recordFactory: args => new CustomBamRecord(args),
  })

  await bamFile.getHeader()
  const records = await bamFile.getRecordsForRange('ctgA', 0, 1000)

  expect(records.length).toEqual(131)
  expect(records[0]).toBeInstanceOf(CustomBamRecord)
  expect(records[0].customProp).toEqual('custom')
  expect(records[0].customMethod).toContain('custom')
})

test('custom record has access to standard properties', async () => {
  const bamFile = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    recordFactory: args => new CustomBamRecord(args),
  })

  await bamFile.getHeader()
  const records = await bamFile.getRecordsForRange('ctgA', 0, 1000)

  expect(records[0].start).toEqual(2)
  expect(records[0].end).toEqual(102)
  expect(records[0].CIGAR).toEqual('100M')
  expect(records[0].name).toEqual('ctgA_3_555_0:0:0_2:0:0_102d')
})

class MinimalCustomRecord implements BamRecordLike {
  private bytes: { start: number; end: number; byteArray: Uint8Array }
  private _fileOffset: number
  private _dataView: DataView

  constructor(args: BamRecordConstructorArgs) {
    this.bytes = args.bytes
    this._fileOffset = args.fileOffset
    this._dataView = new DataView(this.bytes.byteArray.buffer)
  }

  get ref_id() {
    return this._dataView.getInt32(this.bytes.start + 4, true)
  }

  get start() {
    return this._dataView.getInt32(this.bytes.start + 8, true)
  }

  get end() {
    return this.start + this.length_on_ref
  }

  get id() {
    return this._fileOffset
  }

  get name() {
    const b0 = this.bytes.start + 36
    const bin_mq_nl = this._dataView.getInt32(this.bytes.start + 12, true)
    const read_name_length = bin_mq_nl & 0xff
    let str = ''
    for (let i = 0; i < read_name_length - 1; i++) {
      str += String.fromCharCode(this.bytes.byteArray[b0 + i]!)
    }
    return str
  }

  get next_refid() {
    return this._dataView.getInt32(this.bytes.start + 24, true)
  }

  get next_pos() {
    return this._dataView.getInt32(this.bytes.start + 28, true)
  }

  get seq() {
    return ''
  }

  get qual() {
    return undefined
  }

  get CIGAR() {
    return ''
  }

  get tags() {
    return {}
  }

  get flags() {
    return (
      (this._dataView.getInt32(this.bytes.start + 16, true) & 0xffff0000) >> 16
    )
  }

  get mq() {
    const bin_mq_nl = this._dataView.getInt32(this.bytes.start + 12, true)
    const mq = (bin_mq_nl & 0xff00) >> 8
    return mq === 255 ? undefined : mq
  }

  get seq_length() {
    return this._dataView.getInt32(this.bytes.start + 20, true)
  }

  get length_on_ref() {
    return 0
  }
}

test('can use minimal custom record', async () => {
  const bamFile = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
    recordFactory: args => new MinimalCustomRecord(args),
  })

  await bamFile.getHeader()
  const records = await bamFile.getRecordsForRange('ctgA', 0, 1000)

  expect(records.length).toEqual(131)
  expect(records[0]).toBeInstanceOf(MinimalCustomRecord)
  expect(records[0].start).toEqual(2)
  expect(records[0].name).toEqual('ctgA_3_555_0:0:0_2:0:0_102d')
})

test('defaults to BamRecord when no factory provided', async () => {
  const bamFile = new BamFile({
    bamPath: 'test/data/volvox-sorted.bam',
  })

  await bamFile.getHeader()
  const records = await bamFile.getRecordsForRange('ctgA', 0, 1000)

  expect(records.length).toEqual(131)
  expect(records[0]).toBeInstanceOf(BamRecord)
})
