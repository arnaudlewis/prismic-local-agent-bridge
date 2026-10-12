import { singleLine } from "./text.ts"

const maxTitleLength = 80
export const untitledChat = "Untitled chat"

// The title of a thread is its first message, on one line, shortened.
export function deriveTitle(text: string): string {
  const line = singleLine(text)
  if (line === "") return untitledChat
  return line.length > maxTitleLength ? `${line.slice(0, maxTitleLength - 1).trimEnd()}…` : line
}
