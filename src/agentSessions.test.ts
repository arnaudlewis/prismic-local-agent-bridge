import { describe, expect, it } from "vitest"

import { isSlashCommand, toBridgeCommand } from "./agentSessions.ts"

describe("isSlashCommand", () => {
  it.each(["/status", "  /review check the diff", "/review-branch main", "/compact\n"])("detects %j", (text) => {
    expect(isSlashCommand(text)).toBe(true)
  })

  it.each(["status", "what does /status do", "/etc/hosts", "/$skill", "//", "/"])("ignores %j", (text) => {
    expect(isSlashCommand(text)).toBe(false)
  })
})

describe("toBridgeCommand", () => {
  it("keeps the hint of unstructured input", () => {
    expect(toBridgeCommand({ name: "review", description: "Review.", input: { hint: "instructions" } })).toEqual({
      name: "review",
      description: "Review.",
      hint: "instructions",
    })
  })

  it("omits the hint without input", () => {
    expect(toBridgeCommand({ name: "status", description: "Status.", input: null })).toEqual({
      name: "status",
      description: "Status.",
    })
    expect(toBridgeCommand({ name: "$skill", description: "Skill." })).toEqual({
      name: "$skill",
      description: "Skill.",
    })
  })
})
