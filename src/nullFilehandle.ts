export default class NullFilehandle {
  public read(): Promise<never> {
    throw new Error('never called')
  }
  public stat(): Promise<never> {
    throw new Error('never called')
  }

  public readFile(): Promise<never> {
    throw new Error('never called')
  }

  public close(): Promise<never> {
    throw new Error('never called')
  }
}
