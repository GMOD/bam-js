import { beforeEach, describe, expect, it } from 'vitest'
import BamFile from '../src/bamFile.ts'

describe('BamFile.create static factory', () => {
  it('should create BamFile with default record type', () => {
    const bamFile = BamFile.create({
      bamPath: 'test/data/volvox-sorted.bam',
    })
    expect(bamFile).toBeInstanceOf(BamFile)
  })

  it('should create BamFile with custom record factory', async () => {
    const bamFile = BamFile.create({
      bamPath: 'test/data/volvox-sorted.bam',
      recordFactory: args => {
        const record = {
          ...args,
          ref_id: 0,
          start: 0,
          end: 0,
          id: args.fileOffset,
          name: 'custom',
          next_refid: 0,
          next_pos: 0,
          seq: '',
          qual: undefined,
          CIGAR: '',
          tags: {},
          flags: 0,
          mq: undefined,
          seq_length: 0,
        }
        return record
      },
    })
    expect(bamFile).toBeInstanceOf(BamFile)
  })

  it('should work the same as constructor for default case', () => {
    const bamFileConstructor = new BamFile({
      bamPath: 'test/data/volvox-sorted.bam',
    })
    const bamFileFactory = BamFile.create({
      bamPath: 'test/data/volvox-sorted.bam',
    })

    expect(bamFileConstructor).toBeInstanceOf(BamFile)
    expect(bamFileFactory).toBeInstanceOf(BamFile)
  })
})
