import { expect, test } from 'vitest'

import { parseHeaderText } from '../src/sam.ts'

test('parses TAG:VALUE fields', () => {
  expect(parseHeaderText('@SQ\tSN:ctgA\tLN:50001')).toEqual([
    {
      tag: 'SQ',
      data: [
        { tag: 'SN', value: 'ctgA' },
        { tag: 'LN', value: '50001' },
      ],
    },
  ])
})

// @CO lines are free text, not TAG:VALUE — see `samtools view -H c2#pad.3.0.cram`.
// Splitting them on a colon that isn't there used to slice(0, -1) the field,
// putting the comment minus its last character in the tag. Matches what
// @gmod/cram's parseHeaderText returns for the same line.
test('a field with no colon keeps its whole text', () => {
  expect(parseHeaderText('@CO\tthis is a comment')).toEqual([
    { tag: 'CO', data: [{ tag: 'this is a comment', value: '' }] },
  ])
})

// a colon inside the value must not be split on
test('only the first colon separates tag from value', () => {
  expect(parseHeaderText('@PG\tCL:samtools view -o a:b.bam')).toEqual([
    { tag: 'PG', data: [{ tag: 'CL', value: 'samtools view -o a:b.bam' }] },
  ])
})
