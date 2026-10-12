import { describe, expect, it } from "vitest"

import { ClientMessageSchema } from "./protocol.ts"

const base = {
  agent: "codex",
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

describe("thread messages", () => {
  it("accepts threads_list and chat_delete", () => {
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "codex" }).success).toBe(true)
    expect(
      ClientMessageSchema.safeParse({ type: "chat_delete", conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
        .success,
    ).toBe(true)
  })

  it.each([
    { type: "threads_list" },
    { type: "threads_list", repository: "" },
    { type: "threads_list", repository: "r".repeat(201) },
    { type: "chat_delete" },
    { type: "chat_delete", conversationId: "../../etc/passwd" },
    { type: "chat_delete", conversationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { type: "chat_delete", conversationId: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa" },
    { type: "chat_delete", conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../x" },
  ])("rejects %j", (message) => {
    expect(ClientMessageSchema.safeParse(message).success).toBe(false)
  })

  it("no longer knows chat_reset", () => {
    expect(ClientMessageSchema.safeParse({ type: "chat_reset" }).success).toBe(false)
  })
})

describe("session.agent", () => {
  const withAgent = (agent: unknown) =>
    ClientMessageSchema.safeParse({
      type: "chat_open",
      session: { ...base, agent, mcpServerUrl: "http://localhost:3030/mcp" },
    }).success

  it("is required and must be a known agent", () => {
    expect(withAgent("codex")).toBe(true)
    expect(withAgent(undefined)).toBe(false)
    expect(withAgent("claude")).toBe(false)
    expect(withAgent("Codex")).toBe(false)
    expect(withAgent("")).toBe(false)
    expect(withAgent(1)).toBe(false)
  })

  it("is required on chat_prompt sessions too", () => {
    const { agent: _agent, ...withoutAgent } = base
    expect(
      ClientMessageSchema.safeParse({
        type: "chat_prompt",
        text: "hi",
        session: { ...withoutAgent, mcpServerUrl: "http://localhost:3030/mcp" },
      }).success,
    ).toBe(false)
  })

  it("is required on threads_list, which lists only that agent's conversations", () => {
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "codex" }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo" }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "claude" }).success).toBe(false)
  })
})
