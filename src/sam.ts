export function parseHeaderText(text: string) {
  const lines = text.split(/\r?\n/)
  const data: { tag: string; data: { tag: string; value: string }[] }[] = []
  for (const line of lines) {
    const [tag, ...fields] = line.split(/\t/)
    if (tag) {
      data.push({
        tag: tag.slice(1),
        data: fields.map(f => {
          const r = f.indexOf(':')
          // A field with no colon is not a TAG:VALUE pair — @CO lines are free
          // text, one comment per line (`samtools view -H c2#pad.3.0.cram`).
          // Without this branch `slice(0, -1)` silently drops the comment's last
          // character into the tag. Same shape @gmod/cram's parseHeaderText
          // returns, so both feed a consumer's header parser identically.
          return r === -1
            ? { tag: f, value: '' }
            : { tag: f.slice(0, r), value: f.slice(r + 1) }
        }),
      })
    }
  }
  return data
}
