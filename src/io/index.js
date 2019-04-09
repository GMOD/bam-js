const url = require('url')
const RemoteFile = require('./remoteFile')
const LocalFile = require('./localFile')

function fromUrl(source) {
  const { protocol, pathname } = url.parse(source)
  if (protocol === 'file:') {
    return new LocalFile(unescape(pathname))
  }
  return new RemoteFile(source)
}

module.exports = {
  LocalFile,
  RemoteFile,

  fromUrl,

  open(maybeUrl, maybePath, maybeFilehandle) {
    if (maybeFilehandle) return maybeFilehandle
    if (maybeUrl) return fromUrl(maybeUrl)
    if (maybePath) return new LocalFile(maybePath)
    throw new Error('no url, path, or filehandle provided, cannot open')
  },
}
