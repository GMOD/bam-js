const { Inflate, Z_SYNC_FLUSH } = require('pako')

function pakoUnzip(inputData) {
  let strm
  let pos = 0
  let i = 0
  const chunks = []
  let inflator
  do {
    const remainingInput = inputData.slice(pos)
    inflator = new Inflate()
    ;({ strm } = inflator)
    inflator.push(remainingInput, Z_SYNC_FLUSH)
    if (inflator.err) throw new Error(inflator.msg)

    pos += strm.next_in
    chunks[i] = Buffer.from(inflator.result)
    i += 1
  } while (strm.avail_in)

  const result = Buffer.concat(chunks)

  return result
}

// similar to pakounzip, except it does extra counting and
// trimming to make sure to return only exactly the data
// range specified in the chunk
function unzipChunk(inputData, chunk) {
  let strm
  let pos = 0
  const decompressedBlocks = []
  let inflator
  const fileStartingOffset = chunk.minv.blockPosition
  do {
    const remainingInput = inputData.slice(pos)
    inflator = new Inflate()
    ;({ strm } = inflator)
    inflator.push(remainingInput, Z_SYNC_FLUSH)
    if (inflator.err) throw new Error(inflator.msg)

    decompressedBlocks.push(Buffer.from(inflator.result))

    if (decompressedBlocks.length === 1 && chunk.minv.dataPosition) {
      // this is the first chunk, trim it
      decompressedBlocks[0] = decompressedBlocks[0].slice(
        chunk.minv.dataPosition,
      )
    }
    if (fileStartingOffset + pos >= chunk.maxv.blockPosition) {
      // this is the last chunk, trim it and stop decompressing
      // note if it is the same block is minv it subtracts that already
      // trimmed part of the slice length

      decompressedBlocks[decompressedBlocks.length - 1] = decompressedBlocks[
        decompressedBlocks.length - 1
      ].slice(
        0,
        chunk.maxv.blockPosition === chunk.minv.blockPosition
          ? chunk.maxv.dataPosition - chunk.minv.dataPosition + 1
          : chunk.maxv.dataPosition + 1,
      )
      break
    }
    pos += strm.next_in
  } while (strm.avail_in)

  const result = Buffer.concat(decompressedBlocks)
  return result
}

module.exports = {
  unzip: pakoUnzip,
  unzipChunk,
}
