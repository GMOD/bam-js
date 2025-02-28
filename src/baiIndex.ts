import { GenericFilehandle } from 'generic-filehandle2'

export default class BaiIndex {
  filehandle: GenericFilehandle
  constructor({ filehandle }: { filehandle: GenericFilehandle }) {
    this.filehandle = filehandle
  }
  async setup() {
    return JSON.parse(await this.filehandle.readFile('utf8'))
  }
}
