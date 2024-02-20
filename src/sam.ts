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
          const fieldTag = f.slice(0, r)
          const value = f.slice(r + 1)
          return { tag: fieldTag, value }
        }),
      })
    }
  }
  return data
}
