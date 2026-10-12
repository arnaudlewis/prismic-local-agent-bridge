import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { ClientMessageSchema } from "../protocol.ts"
import { conversationId, session, createHarness, windowA, windowB, windowC, chatHistory, agentText, liveAgentText, lastStatus, conversationFile } from "../testing/harness.ts"

describe("persistent conversations", () => {
  it("replays the history to a second window, before session_config, and stops feeding the first", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })

    const eventsB = harness.eventsFor(windowB)
    const kinds = eventsB.map((event) => event.type)
    expect(kinds[0]).toBe("chat_history")
    expect(kinds.indexOf("chat_history")).toBeLessThan(kinds.indexOf("session_config"))
    expect(kinds.indexOf("chat_history")).toBeLessThan(kinds.indexOf("available_commands"))
    const history = chatHistory(eventsB)
    expect(history[0]).toEqual({ type: "user_message", text: "hello" })
    expect(history.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" })
    expect(history.filter((event) => event.type === "agent_message_chunk")).toHaveLength(1)
    expect(agentText(history)).toContain(`ctx:new:${windowA}`)
    expect(lastStatus(eventsB)).toBe("idle")

    const countA = harness.eventsFor(windowA).length
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "again", session })
    expect(harness.eventsFor(windowA)).toHaveLength(countA)
    expect(liveAgentText(harness.eventsFor(windowB))).toContain("prompt:again")
  })

  it("restarts the agent with resume when the window changes, binding the MCP header to the new window", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "first", session })
    expect(liveAgentText(harness.eventsFor(windowA))).toContain(`ctx:new:${windowA}`)

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "second", session })

    const textB = liveAgentText(harness.eventsFor(windowB))
    expect(textB).toContain(`ctx:load:${windowB}`)
    expect(textB).not.toContain("replayed-history")
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)
    expect(harness.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)
  })

  it("does not start a resume for a conversation that never got a prompt", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "first", session })

    expect(liveAgentText(harness.eventsFor(windowB))).toContain(`ctx:new:${windowB}`)
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)
  })

  it("keeps a turn running after the window goes away and shows it as running to the next window", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    const countA = harness.eventsFor(windowA).length

    harness.agents.detachWindow(windowA)
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })

    const eventsB = harness.eventsFor(windowB)
    const history = chatHistory(eventsB)
    expect(history[0]).toEqual({ type: "user_message", text: "hold on" })
    expect(agentText(history)).toBe("working")
    expect(lastStatus(eventsB)).toBe("running")
    expect(harness.eventsFor(windowA)).toHaveLength(countA)

    await harness.agents.handleMessage(windowB, { type: "chat_cancel" })
    await turn
    expect(harness.eventsFor(windowB)).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
    expect(lastStatus(harness.eventsFor(windowB))).toBe("idle")
  })

  it("records events produced while no window is attached", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    harness.agents.detachWindow(windowA)

    await harness.agents.handleMessage(windowC, { type: "chat_open", session })
    const request = chatHistory(harness.eventsFor(windowC)).find((event) => event.type === "permission_request")
    expect(request).toBeDefined()
    await harness.agents.handleMessage(windowC, {
      type: "permission_response",
      requestId: request?.type === "permission_request" ? request.requestId : "",
      optionId: "allow",
    })
    await turn
    expect(liveAgentText(harness.eventsFor(windowC))).toContain("permission:allow")
  })

  it("keeps an unresolved permission request answerable after a refresh and marks resolved ones", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    const pendingHistory = chatHistory(harness.eventsFor(windowB))
    const request = pendingHistory.find((event) => event.type === "permission_request")
    expect(request).toMatchObject({ type: "permission_request", title: "Run tool" })
    expect(pendingHistory.some((event) => event.type === "permission_resolved")).toBe(false)
    expect(lastStatus(harness.eventsFor(windowB))).toBe("running")

    const requestId = request?.type === "permission_request" ? request.requestId : ""
    await harness.agents.handleMessage(windowB, { type: "permission_response", requestId, optionId: "allow" })
    await turn

    await harness.agents.handleMessage(windowC, { type: "chat_open", session })
    const resolvedHistory = chatHistory(harness.eventsFor(windowC))
    const kinds = resolvedHistory.map((event) => event.type)
    expect(kinds.indexOf("permission_resolved")).toBeGreaterThan(kinds.indexOf("permission_request"))
    expect(resolvedHistory.find((event) => event.type === "permission_resolved")).toEqual({
      type: "permission_resolved",
      requestId,
      optionId: "allow",
    })
    expect(agentText(resolvedHistory)).toContain("permission:allow")
  })

  it("records a cancelled permission without an optionId", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    const request = harness.eventsFor(windowA).find((event) => event.type === "permission_request")

    await harness.agents.handleMessage(windowA, {
      type: "permission_response",
      requestId: request?.type === "permission_request" ? request.requestId : "",
    })
    await turn

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    const resolved = chatHistory(harness.eventsFor(windowB)).find((event) => event.type === "permission_resolved")
    expect(resolved).toEqual({ type: "permission_resolved", requestId: expect.any(String) })
    expect(agentText(chatHistory(harness.eventsFor(windowB)))).toContain("permission:cancelled")
  })

  it("survives a daemon restart: history comes back from disk and the agent resumes with loadSession", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    await first.agents.handleMessage(windowA, { type: "chat_prompt", text: "use-tool please", session })
    first.agents.stopAll()

    const file = conversationFile(first)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; acpSessionId?: string; repository: string }
    expect(onDisk).toMatchObject({ version: 1, repository: "repo", acpSessionId: "fake-session" })

    const second = createHarness({ dataDir: first.dataDir })
    await second.agents.handleMessage(windowB, { type: "chat_open", session })

    const history = chatHistory(second.eventsFor(windowB))
    expect(history[0]).toEqual({ type: "user_message", text: "use-tool please" })
    expect(history.map((event) => event.type)).toEqual([
      "user_message",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "turn_end",
    ])
    expect(second.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)

    await second.agents.handleMessage(windowB, { type: "chat_prompt", text: "next", session })
    const live = liveAgentText(second.eventsFor(windowB))
    expect(live).toContain(`ctx:load:${windowB}`)
    expect(live).not.toContain("replayed-history")
    expect(second.events.some((event) => event.type === "notice")).toBe(false)
    // The preamble was already sent in the first run, so it must not be sent again.
    expect(live).not.toContain("You are running inside")
  })

  it("persists a transcript that a restart marks as unresolved permissions cancelled", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    void first.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(first.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    first.agents.stopAll()

    const second = createHarness({ dataDir: first.dataDir })
    await second.agents.handleMessage(windowB, { type: "chat_open", session })

    const kinds = chatHistory(second.eventsFor(windowB)).map((event) => event.type)
    expect(kinds).toContain("permission_request")
    expect(kinds.at(-1)).toBe("permission_resolved")
  })

  it("deletes the transcript, the stored session and the file on chat_delete, and starts fresh", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "first", session })
    await vi.waitFor(() => expect(existsSync(conversationFile(harness))).toBe(true))

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })
    expect(existsSync(conversationFile(harness))).toBe(false)

    harness.events.length = 0
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    expect(chatHistory(harness.events)).toEqual([])
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "second", session })
    const text = liveAgentText(harness.events)
    expect(text).toContain("ctx:new")
    expect(text).toContain("You are running inside")
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)

    harness.agents.stopAll()
    const restarted = createHarness({ dataDir: harness.dataDir })
    await restarted.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(chatHistory(restarted.eventsFor(windowB)).map((event) => event.type)).not.toContain("tool_call")
    expect(chatHistory(restarted.eventsFor(windowB))[0]).toEqual({ type: "user_message", text: "second" })
  })

  it("ignores a corrupt stored conversation and starts fresh", async () => {
    const harness = createHarness()
    mkdirSync(join(harness.dataDir, "conversations"), { recursive: true })
    writeFileSync(conversationFile(harness), "not json at all")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(chatHistory(harness.eventsFor(windowA))).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not json at all")
    warn.mockRestore()
    expect(harness.eventsFor(windowA).some((event) => event.type === "session_config")).toBe(true)
  })

  it("stops an idle conversation without a window after the TTL but keeps it on disk", async () => {
    const harness = createHarness({ idleTtlMs: 50 })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })
    harness.agents.detachWindow(windowA)

    await vi.waitFor(() => expect(existsSync(conversationFile(harness))).toBe(true))

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(chatHistory(harness.eventsFor(windowB))[0]).toEqual({ type: "user_message", text: "hello" })
    expect(harness.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)
  })

  it("ignores messages from a window that was replaced by a newer one", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "set_config_option", configId: "mode", value: "agent" })

    expect(harness.eventsFor(windowA)).toEqual([
      { type: "notice", tone: "info", text: "The local agent isn't running yet." },
    ])
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})

describe("conversationId validation", () => {
  const base = { agent: "codex", repository: "repo" }

  it.each([
    "../../etc/passwd",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../x",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
    "",
  ])("rejects %j", (id) => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: { ...base, conversationId: id } }).success).toBe(
      false,
    )
    expect(
      ClientMessageSchema.safeParse({ type: "chat_prompt", text: "hi", session: { ...base, conversationId: id } })
        .success,
    ).toBe(false)
  })

  it("requires a conversationId and accepts a lowercase UUID v4", () => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: base }).success).toBe(false)
    expect(
      ClientMessageSchema.safeParse({
        type: "chat_open",
        session: { ...base, conversationId: crypto.randomUUID() },
      }).success,
    ).toBe(true)
  })
})

describe("input bounds", () => {
  const base = { agent: "codex", conversationId, repository: "repo" }

  it.each([
    ["repository", { ...base, repository: "r".repeat(201) }],
    ["document id", { ...base, document: { id: "i".repeat(301), title: "t" } }],
    ["document title", { ...base, document: { id: "i", title: "t".repeat(301) } }],
  ])("rejects an oversized session %s", (_name, oversized) => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: oversized }).success).toBe(false)
  })

  it("accepts values at the limits", () => {
    const atLimits = { ...base, repository: "r".repeat(200), document: { id: "i".repeat(300), title: "t".repeat(300) } }
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: atLimits }).success).toBe(true)
  })

  it("rejects oversized prompt text, config values and permission ids", () => {
    expect(ClientMessageSchema.safeParse({ type: "chat_prompt", text: "x".repeat(20_001), session: base }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "chat_prompt", text: "x".repeat(20_000), session: base }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: "set_config_option", configId: "mode", value: "v".repeat(201) }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "set_config_option", configId: "c".repeat(201), value: "v" }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "permission_response", requestId: "r".repeat(201) }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: "permission_response", requestId: "r", optionId: "o".repeat(201) }).success).toBe(false)
  })
})
