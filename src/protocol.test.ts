import { describe, expect, it } from "vitest"

import { ClientMessageSchema } from "./protocol.ts"

const base = {
  agent: "codex",
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  repository: "repo",
}

describe("session", () => {
  it("accepts the sessions of chat_open and chat_prompt without any Prismic credential", () => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: base }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: "chat_prompt", text: "hi", session: base }).success).toBe(true)
  })

  it("drops a Prismic token or MCP URL sent by an older browser, so it never reaches the conversation", () => {
    const legacy = { ...base, prismicToken: "secret-token", mcpServerUrl: "https://example.com/mcp" }

    const open = ClientMessageSchema.parse({ type: "chat_open", session: legacy })
    const prompt = ClientMessageSchema.parse({ type: "chat_prompt", text: "hi", session: legacy })

    for (const message of [open, prompt]) {
      expect(message).toHaveProperty("session")
      expect("session" in message ? message.session : undefined).toEqual(base)
    }
  })
})

describe("thread messages", () => {
  it("accepts threads_list and chat_delete", () => {
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "codex" }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "claude" }).success).toBe(true)
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
      session: { ...base, agent },
    }).success

  it("is required and must be a known agent", () => {
    expect(withAgent("codex")).toBe(true)
    expect(withAgent("claude")).toBe(true)
    expect(withAgent(undefined)).toBe(false)
    expect(withAgent("gemini")).toBe(false)
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
        session: withoutAgent,
      }).success,
    ).toBe(false)
  })

  it("is required on threads_list, which lists only that agent's conversations", () => {
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "codex" }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo" }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "threads_list", repository: "repo", agent: "gemini" }).success).toBe(false)
  })
})
