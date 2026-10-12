import { describe, expect, it } from "vitest"

import type { HistoryEvent } from "./protocol.ts"
import { createTranscript } from "./transcript.ts"

function chunk(text: string, messageId?: string): HistoryEvent {
  return { type: "agent_message_chunk", text, messageId }
}

function permissionRequest(requestId: string): HistoryEvent {
  return { type: "permission_request", requestId, title: "Run", options: [] }
}

describe("createTranscript", () => {
  it("merges consecutive chunks with the same messageId, or both without one", () => {
    const transcript = createTranscript()
    transcript.append(chunk("Hel", "m1"))
    transcript.append(chunk("lo", "m1"))
    transcript.append(chunk(" there", "m2"))
    transcript.append(chunk("!", "m2"))
    transcript.append(chunk("a"))
    transcript.append(chunk("b"))

    expect(transcript.events()).toEqual([chunk("Hello", "m1"), chunk(" there!", "m2"), chunk("ab")])
  })

  it("does not merge chunks separated by another event", () => {
    const transcript = createTranscript()
    transcript.append(chunk("a"))
    transcript.append({ type: "tool_call", toolCallId: "t", title: "Tool", status: "pending" })
    transcript.append(chunk("b"))

    expect(transcript.events()).toHaveLength(3)
  })

  it("drops the oldest whole events beyond the event cap", () => {
    const transcript = createTranscript({ limits: { maxEvents: 3, maxBytes: 1_000_000 } })
    for (let index = 0; index < 6; index++) transcript.append({ type: "user_message", text: `m${index}` })

    expect(transcript.events()).toEqual([
      { type: "user_message", text: "m3" },
      { type: "user_message", text: "m4" },
      { type: "user_message", text: "m5" },
    ])
  })

  it("drops the oldest whole events beyond the byte cap but keeps the latest one", () => {
    const transcript = createTranscript({ limits: { maxEvents: 100, maxBytes: 300 } })
    for (let index = 0; index < 20; index++) transcript.append({ type: "user_message", text: `${index}`.repeat(50) })
    transcript.append({ type: "user_message", text: "x".repeat(1000) })

    expect(transcript.events()).toEqual([{ type: "user_message", text: "x".repeat(1000) }])
  })

  it("never drops a permission request that is still unresolved", () => {
    const transcript = createTranscript({ limits: { maxEvents: 3, maxBytes: 1_000_000 } })
    transcript.append(permissionRequest("pending"))
    transcript.append(permissionRequest("answered"))
    transcript.append({ type: "permission_resolved", requestId: "answered" })
    for (let index = 0; index < 5; index++) transcript.append({ type: "user_message", text: `m${index}` })

    const events = transcript.events()
    expect(events).toContainEqual(permissionRequest("pending"))
    expect(events).not.toContainEqual(permissionRequest("answered"))
    expect(transcript.unresolvedPermissionIds()).toEqual(["pending"])
  })

  it("lists permission requests that were never resolved when loaded from stored events", () => {
    const transcript = createTranscript({
      events: [permissionRequest("a"), permissionRequest("b"), { type: "permission_resolved", requestId: "a" }],
    })

    expect(transcript.unresolvedPermissionIds()).toEqual(["b"])
  })

  it("clears everything", () => {
    const transcript = createTranscript()
    transcript.append(permissionRequest("a"))
    transcript.clear()

    expect(transcript.events()).toEqual([])
    expect(transcript.unresolvedPermissionIds()).toEqual([])
  })

  it("truncates a single oversized event with a visible marker", () => {
    const transcript = createTranscript()
    transcript.append({ type: "user_message", text: "x".repeat(250_000) })
    transcript.append({ type: "notice", tone: "error", text: "n".repeat(150_000) })

    const [user, notice] = transcript.events()
    expect(user?.type === "user_message" && user.text.length).toBe(100_000)
    expect(user?.type === "user_message" && user.text.endsWith("…[truncated]")).toBe(true)
    expect(notice?.type === "notice" && notice.text.endsWith("…[truncated]")).toBe(true)
  })

  it("truncates merged agent chunks and ignores what follows", () => {
    const transcript = createTranscript()
    for (let index = 0; index < 5; index++) transcript.append(chunk("a".repeat(30_000), "m1"))
    transcript.append(chunk("tail", "m1"))

    const events = transcript.events()
    expect(events).toHaveLength(1)
    const [merged] = events
    expect(merged?.type === "agent_message_chunk" && merged.text.length).toBe(100_000)
    expect(merged?.type === "agent_message_chunk" && merged.text.endsWith("…[truncated]")).toBe(true)
  })

  it("bounds ids and the number of permission options", () => {
    const transcript = createTranscript()
    transcript.append({
      type: "permission_request",
      requestId: "r",
      title: "t",
      options: Array.from({ length: 50 }, (_, index) => ({ optionId: `o${index}`, name: "n".repeat(5000), kind: "k" })),
    })
    transcript.append({ type: "tool_call", toolCallId: "i".repeat(5000), title: "t", status: "pending" })

    const [request, tool] = transcript.events()
    expect(request?.type === "permission_request" && request.options).toHaveLength(20)
    expect(request?.type === "permission_request" && request.options[0]?.name.length).toBe(1000)
    expect(tool?.type === "tool_call" && tool.toolCallId.length).toBe(1000)
  })

  it("measures the byte cap in bytes, not characters", () => {
    const transcript = createTranscript({ limits: { maxEvents: 100, maxBytes: 1000 } })
    for (let index = 0; index < 4; index++) transcript.append({ type: "user_message", text: "é".repeat(150) })

    // 4 x (150 two-byte characters + JSON overhead) is over 1000 bytes but only about 760 characters.
    expect(transcript.events().length).toBeLessThan(4)
  })
})
