import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { conversationId, session, createHarness, notices, windowA, windowB, chatHistory, agentText, liveAgentText, lastStatus, conversationFile, conversationIdFor, sessionFor, windowFor, openAndPrompt, tooMany } from "../testing/harness.ts"

describe("resource caps", () => {
  it("stops the least recently active detached idle agent to make room, and resumes it later", async () => {
    const harness = createHarness({ maxLiveAgents: 2 })
    await openAndPrompt(harness, 1)
    await openAndPrompt(harness, 2)
    harness.agents.detachWindow(windowFor(1))
    harness.agents.detachWindow(windowFor(2))

    await openAndPrompt(harness, 3)

    expect(notices(harness.eventsFor(windowFor(3)))).toEqual([])
    expect(liveAgentText(harness.eventsFor(windowFor(3)))).toContain("ctx:new")

    // Conversation 1 was the least recently active: it was the one stopped, so it resumes with loadSession.
    harness.agents.detachWindow(windowFor(3))
    await openAndPrompt(harness, 1, "again")
    const resumed = liveAgentText(harness.eventsFor(windowFor(1)))
    expect(resumed).toContain("ctx:load")
    expect(notices(harness.eventsFor(windowFor(1)))).toEqual([])
    expect(chatHistory(harness.eventsFor(windowFor(1)))[0]).toEqual({ type: "user_message", text: "hello" })
  })

  it("refuses with a notice when every agent is attached to a window", async () => {
    const harness = createHarness({ maxLiveAgents: 2 })
    await openAndPrompt(harness, 1)
    await openAndPrompt(harness, 2)

    await harness.agents.handleMessage(windowFor(3), { type: "chat_open", session: sessionFor(3) })

    const events = harness.eventsFor(windowFor(3))
    expect(notices(events)).toEqual([tooMany])
    expect(events.some((event) => event.type === "notice" && event.tone === "error")).toBe(true)
    expect(events.some((event) => event.type === "session_config")).toBe(false)
    expect(lastStatus(events)).toBe("idle")
    // The agents that were running are untouched.
    await harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "still here", session: sessionFor(1) })
    expect(liveAgentText(harness.eventsFor(windowFor(1)))).toContain("prompt:still here")
  })

  it("never stops a detached agent that has a turn running or a permission pending", async () => {
    const harness = createHarness({ maxLiveAgents: 2 })
    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(1) })
    const turn = harness.agents.handleMessage(windowFor(1), { type: "chat_prompt", text: "hold on", session: sessionFor(1) })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowFor(1)))).toContain("working"))
    await harness.agents.handleMessage(windowFor(2), { type: "chat_open", session: sessionFor(2) })
    const permissionTurn = harness.agents.handleMessage(windowFor(2), {
      type: "chat_prompt",
      text: "ask-permission",
      session: sessionFor(2),
    })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowFor(2)).some((event) => event.type === "permission_request")).toBe(true),
    )
    harness.agents.detachWindow(windowFor(1))
    harness.agents.detachWindow(windowFor(2))

    await harness.agents.handleMessage(windowFor(3), { type: "chat_open", session: sessionFor(3) })

    expect(notices(harness.eventsFor(windowFor(3)))).toEqual([tooMany])

    await harness.agents.handleMessage(windowFor(4), { type: "chat_open", session: sessionFor(1) })
    await harness.agents.handleMessage(windowFor(4), { type: "chat_cancel" })
    await turn
    const request = harness.eventsFor(windowFor(2)).find((event) => event.type === "permission_request")
    await harness.agents.handleMessage(windowFor(5), { type: "chat_open", session: sessionFor(2) })
    await harness.agents.handleMessage(windowFor(5), {
      type: "permission_response",
      requestId: request?.type === "permission_request" ? request.requestId : "",
      optionId: "allow",
    })
    await permissionTurn
  })

  it("does not let concurrent starts exceed the cap", async () => {
    const harness = createHarness({ maxLiveAgents: 2 })
    await Promise.all(
      [1, 2, 3].map((index) =>
        harness.agents.handleMessage(windowFor(index), { type: "chat_open", session: sessionFor(index) }),
      ),
    )

    const refused = [1, 2, 3].filter((index) => notices(harness.eventsFor(windowFor(index))).includes(tooMany))
    expect(refused).toHaveLength(1)
  })

  it("drops detached agentless conversations from memory when there are too many, keeping them on disk", async () => {
    const harness = createHarness({ maxLiveAgents: 1, maxConversations: 2 })
    await openAndPrompt(harness, 1)
    harness.agents.detachWindow(windowFor(1))
    await openAndPrompt(harness, 2)
    // Conversation 1 lost its agent to conversation 2 and is now only memory; opening 3 evicts it from memory.
    await harness.agents.handleMessage(windowFor(3), { type: "chat_open", session: sessionFor(3) })
    expect(notices(harness.eventsFor(windowFor(3)))).toEqual([tooMany])

    harness.agents.detachWindow(windowFor(2))
    harness.agents.detachWindow(windowFor(3))
    await harness.agents.handleMessage(windowFor(1), { type: "chat_open", session: sessionFor(1) })

    expect(chatHistory(harness.eventsFor(windowFor(1)))[0]).toEqual({ type: "user_message", text: "hello" })
    expect(existsSync(join(harness.dataDir, "conversations", `${conversationIdFor(1)}.json`))).toBe(true)
  })
})

describe("detached activity limits", () => {
  it("cancels a detached turn that runs longer than the limit", async () => {
    const harness = createHarness({ detachedActivityLimitMs: 150, detachedSweepIntervalMs: 50 })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    harness.agents.detachWindow(windowA)

    await turn

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(chatHistory(harness.eventsFor(windowB))).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
    expect(lastStatus(harness.eventsFor(windowB))).toBe("idle")
  })

  it("cancels a permission request nobody answered within the limit", async () => {
    const harness = createHarness({ detachedActivityLimitMs: 150, detachedSweepIntervalMs: 50 })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    harness.agents.detachWindow(windowA)

    await turn

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    const history = chatHistory(harness.eventsFor(windowB))
    expect(history.some((event) => event.type === "permission_resolved" && event.optionId === undefined)).toBe(true)
    expect(agentText(history)).toContain("permission:cancelled")
  })

  it("leaves an attached conversation alone", async () => {
    const harness = createHarness({ detachedActivityLimitMs: 100, detachedSweepIntervalMs: 30 })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))

    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(harness.eventsFor(windowA).some((event) => event.type === "turn_end")).toBe(false)
    await harness.agents.handleMessage(windowA, { type: "chat_cancel" })
    await turn
  })
})

describe("stale agent callbacks", () => {
  it("records nothing and recreates no file for text and permission requests sent after chat_delete", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "bridge-late-")), "late.log")
    process.env.FAKE_AGENT_LOG = logFile
    try {
      const harness = createHarness()
      await harness.agents.handleMessage(windowA, { type: "chat_open", session })
      void harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "late-output", session })
      await vi.waitFor(() => expect(harness.eventsFor(windowA).some((event) => event.type === "chat_status" && event.status === "running")).toBe(true))

      await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })
      const sentAfterReset = harness.eventsFor(windowA).length
      await vi.waitFor(() => expect(existsSync(logFile)).toBe(true), { timeout: 4000 })

      expect(readFileSync(logFile, "utf8")).toContain("late-permission:cancelled")
      expect(harness.eventsFor(windowA)).toHaveLength(sentAfterReset)
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(false)
      expect(liveAgentText(harness.eventsFor(windowA))).not.toContain("late-text")
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(existsSync(conversationFile(harness))).toBe(false)

      await harness.agents.handleMessage(windowB, { type: "chat_open", session })
      expect(chatHistory(harness.eventsFor(windowB))).toEqual([])
    } finally {
      delete process.env.FAKE_AGENT_LOG
    }
  })

  it("keeps at most 20 unanswered permission requests per agent and cancels the extras", async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "bridge-flood-")), "flood.log")
    process.env.FAKE_AGENT_LOG = logFile
    try {
      const harness = createHarness()
      await harness.agents.handleMessage(windowA, { type: "chat_open", session })
      const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "flood-permissions", session })
      await vi.waitFor(() => expect(readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toHaveLength(5))

      const requests = harness.eventsFor(windowA).filter((event) => event.type === "permission_request")
      expect(requests).toHaveLength(20)
      expect(readFileSync(logFile, "utf8").split("\n").filter(Boolean)).toEqual(Array(5).fill("flood:cancelled"))

      await harness.agents.handleMessage(windowA, { type: "chat_cancel" })
      await turn
    } finally {
      delete process.env.FAKE_AGENT_LOG
    }
  })
})
