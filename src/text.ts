// Titles come from document content: keep them on one short line so they can't inject extra lines or break out of quotes.
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").replaceAll('"', "'").trim().slice(0, 200)
}
