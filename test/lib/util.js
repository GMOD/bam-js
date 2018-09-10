const path = typeof __webpack_require__ !== 'function' ? require('path') : null // eslint-disable-line camelcase
const fs = typeof __webpack_require__ !== 'function' ? require('fs') : null // eslint-disable-line camelcase
const { fromUrl } = require('./io')

const dataDir =
  path && path.dirname(require.resolve('../data/volvox-sorted.bam'))

function testDataUrl(filename) {
  return typeof window === 'undefined'
    ? `file://${dataDir}/${filename}`.replace('#', '%23')
    : `http://localhost:9876/base/test/data/${filename.replace('#', '%23')}`
}

function testDataFile(filename) {
  const source = testDataUrl(filename)
  return fromUrl(source)
}

async function loadTestJSON(filename) {
  const data = await testDataFile(`${filename}`).readFile()
  const text = data.toString()
  return JSON.parse(text)
}

function JsonClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

let extended = xit
try {
  if (fs.existsSync(require.resolve(`../data/extended/insilico_21.bam`)))
    extended = it
} catch (e) {
  // ignore
  console.log(
    'extended tests disabled, download the extended test dataset and fix all the symlinks in tests/data/extended to enable them',
  )
}

const REWRITE_EXPECTED_DATA =
  typeof process !== 'undefined' &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA !== '0' &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA !== 'false'

module.exports = {
  testDataUrl,
  testDataFile,
  loadTestJSON,
  extended,
  JsonClone,
  REWRITE_EXPECTED_DATA,
  fs,
}
