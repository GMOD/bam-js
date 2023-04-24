export function parseHeaderText(text: string) {
  const lines = text.split(/\r?\n/)
  const data: { tag: string; data: { tag: string; value: string }[] }[] = []
  for (const line of lines) {
    const [tag, ...fields] = line.split(/\t/)
    const parsedFields = fields.map(f => {
      const [fieldTag, value] = f.split(':', 2)
      return { tag: fieldTag, value }
    })
    if (tag) {
      data.push({ tag: tag.slice(1), data: parsedFields })
    }
  }
  return data
}
