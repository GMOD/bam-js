function JsonClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

const REWRITE_EXPECTED_DATA =
  typeof process !== 'undefined' &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA !== '0' &&
  process.env.BAMJS_REWRITE_EXPECTED_DATA !== 'false'

module.exports = {
  JsonClone,
  REWRITE_EXPECTED_DATA,
}
