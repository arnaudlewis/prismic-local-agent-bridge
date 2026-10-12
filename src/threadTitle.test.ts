import { describe, expect, it } from "vitest"

import { deriveTitle, untitledChat } from "./threadTitle.ts"

describe("deriveTitle", () => {
  it("keeps a short message as it is", () => {
    expect(deriveTitle("Shorten the hero title")).toBe("Shorten the hero title")
  })

  it("collapses whitespace and line breaks to a single trimmed line", () => {
    expect(deriveTitle("  What is\n\n in\tthis   slice?  \n")).toBe("What is in this slice?")
  })

  it("cuts at 80 characters with an ellipsis", () => {
    const title = deriveTitle("word ".repeat(40))

    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith("…")).toBe(true)
    expect(deriveTitle("a".repeat(80))).toBe("a".repeat(80))
    expect(deriveTitle("a".repeat(81))).toBe(`${"a".repeat(79)}…`)
  })

  it("falls back for a message that is only whitespace", () => {
    expect(deriveTitle("   \n\t ")).toBe(untitledChat)
    expect(untitledChat).toBe("Untitled chat")
  })

  it("keeps a slash command as typed", () => {
    expect(deriveTitle("/status")).toBe("/status")
  })
})
