import { describe, expect, it } from "vitest"

import { ClientMessageSchema } from "./protocol.ts"

const base = {
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  prismicToken: "token",
  repository: "repo",
}

function acceptsUrl(mcpServerUrl: string): boolean {
  return ClientMessageSchema.safeParse({ type: "chat_open", session: { ...base, mcpServerUrl } }).success
}

describe("session.mcpServerUrl", () => {
  it.each([
    "http://localhost:3030/mcp",
    "http://127.0.0.1:3030/mcp",
    "https://pull-2097-mcp.example.com/mcp",
    "https://example.com/mcp?x=1",
  ])("accepts %s", (url) => {
    expect(acceptsUrl(url)).toBe(true)
  })

  it.each([
    "http://user:pass@localhost:3030/mcp",
    "https://user@example.com/mcp",
    "https://:secret@example.com/mcp",
    "http://localhost@evil.example/mcp",
  ])("rejects credentials in %s", (url) => {
    expect(acceptsUrl(url)).toBe(false)
  })

  it.each([
    "ftp://example.com/mcp",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ws://localhost:3030/mcp",
    "wss://example.com/mcp",
    "data:text/plain,hi",
    "//example.com/mcp",
    "example.com/mcp",
    "",
  ])("rejects the non-http(s) or malformed URL %j", (url) => {
    expect(acceptsUrl(url)).toBe(false)
  })

  it("applies to chat_prompt sessions too", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "chat_prompt",
        text: "hi",
        session: { ...base, mcpServerUrl: "https://user:pass@example.com/mcp" },
      }).success,
    ).toBe(false)
  })
})
