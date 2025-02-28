export default class NullFilehandle {
  public read(): Promise<any> {
    throw new Error('never called')
  }
  public stat(): Promise<any> {
    throw new Error('never called')
  }

  public readFile(): Promise<any> {
    throw new Error('never called')
  }

  public close(): Promise<any> {
    throw new Error('never called')
  }
}
