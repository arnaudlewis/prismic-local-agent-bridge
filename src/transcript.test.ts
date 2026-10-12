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
})
