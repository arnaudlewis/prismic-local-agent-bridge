import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"

import type { ClientMessage } from "./protocol.ts"
import { createWindowChannels } from "./windowChannels.ts"

const windowId = "11111111-1111-4111-8111-111111111111"

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: string[] = []

  send(data: string): void {
    this.sent.push(data)
  }

  closed: Array<{ code?: number; reason?: string }> = []

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason })
    this.readyState = 3
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false)
  }
}

function attach(
  channels: ReturnType<typeof createWindowChannels>,
  isAuthorized: () => boolean = () => true,
  mcpOrigin = "https://mcp.prismic.io",
): FakeSocket {
  const socket = new FakeSocket()
  channels.attach(windowId, socket as unknown as WebSocket, { isAuthorized, mcpOrigin, origin: "http://localhost:5173" })
  return socket
}

describe("createWindowChannels", () => {
  it("ignores frames from a socket that was replaced, including permission_response and threads_list", () => {
    const channels = createWindowChannels()
    const received: ClientMessage[] = []
    channels.onMessage((_windowId, message) => received.push(message))
    const oldSocket = attach(channels)
    const newSocket = attach(channels)

    oldSocket.receive({ type: "permission_response", requestId: "r1", optionId: "allow" })
    oldSocket.receive({ type: "threads_list", repository: "repo", agent: "codex" })
    expect(received).toEqual([])

    newSocket.receive({ type: "threads_list", repository: "repo", agent: "codex" })
    expect(received).toEqual([{ type: "threads_list", repository: "repo", agent: "codex" }])
  })

  it("removes the listeners of the replaced socket", () => {
    const channels = createWindowChannels()
    const oldSocket = attach(channels)
    expect(oldSocket.listenerCount("message")).toBe(1)

    attach(channels)

    expect(oldSocket.listenerCount("message")).toBe(0)
    expect(oldSocket.listenerCount("close")).toBe(0)
  })

  it("does not start the close grace of the window when the replaced socket closes late", () => {
    vi.useFakeTimers()
    try {
      const channels = createWindowChannels()
      const closed = vi.fn()
      channels.onWindowClosed(closed)
      const oldSocket = attach(channels)
      attach(channels)

      oldSocket.emit("close")
      vi.advanceTimersByTime(60_000)

      expect(closed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("sends only to the current socket", () => {
    const channels = createWindowChannels()
    const oldSocket = attach(channels)
    const newSocket = attach(channels)

    channels.send(windowId, { type: "chat_status", status: "idle" })

    expect(oldSocket.sent).toEqual([])
    expect(newSocket.sent).toHaveLength(1)
  })

  it("checks the authorization before every message, and closes with 4401 without dispatching once it is gone", () => {
    const channels = createWindowChannels()
    const received: ClientMessage[] = []
    channels.onMessage((_windowId, message) => received.push(message))
    let authorized = true
    const socket = attach(channels, () => authorized)

    socket.receive({ type: "chat_cancel" })
    expect(received).toEqual([{ type: "chat_cancel" }])

    authorized = false
    socket.receive({ type: "threads_list", repository: "repo", agent: "codex" })
    socket.receive({ type: "permission_response", requestId: "r1", optionId: "allow" })

    expect(received).toEqual([{ type: "chat_cancel" }])
    expect(socket.closed[0]).toEqual({ code: 4401, reason: "unauthorized" })
  })

  it("re-checks idle sockets periodically and closes the ones whose pairing is gone", () => {
    vi.useFakeTimers()
    try {
      const channels = createWindowChannels()
      let authorized = true
      const socket = attach(channels, () => authorized)

      vi.advanceTimersByTime(60_000)
      expect(socket.closed).toEqual([])

      authorized = false
      vi.advanceTimersByTime(60_000)
      expect(socket.closed).toEqual([{ code: 4401, reason: "unauthorized" }])

      // It is checked no more once closed.
      vi.advanceTimersByTime(300_000)
      expect(socket.closed).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("knows the MCP origin of the window's socket while it is attached, and forgets it once the socket closed", () => {
    const channels = createWindowChannels()
    expect(channels.mcpOrigin(windowId)).toBeUndefined()

    const socket = attach(channels, () => true, "https://mcp.wroom.io")
    expect(channels.mcpOrigin(windowId)).toBe("https://mcp.wroom.io")
    expect(channels.mcpOrigin("22222222-2222-4222-8222-222222222222")).toBeUndefined()

    socket.emit("close")
    expect(channels.mcpOrigin(windowId)).toBeUndefined()
  })

  it("reports the distinct page origins that have a socket attached, only when that set changes", () => {
    const channels = createWindowChannels()
    const reported: string[][] = []
    channels.onEditorsChanged((origins) => reported.push(origins))
    const otherWindow = "22222222-2222-4222-8222-222222222222"
    const thirdWindow = "33333333-3333-4333-8333-333333333333"
    const attachTo = (id: string, origin: string) => {
      const socket = new FakeSocket()
      channels.attach(id, socket as unknown as WebSocket, { isAuthorized: () => true, mcpOrigin: "https://mcp.prismic.io", origin })
      return socket
    }

    const first = attachTo(windowId, "http://localhost:5173")
    const second = attachTo(otherWindow, "http://localhost:5173")
    attachTo(thirdWindow, "https://app.example.com")
    first.emit("close")
    second.emit("close")

    expect(reported).toEqual([
      ["http://localhost:5173"],
      ["http://localhost:5173", "https://app.example.com"],
      ["https://app.example.com"],
    ])
  })

  it("answers with the MCP origin of the replacing socket, also when the replaced one closes late", () => {
    const channels = createWindowChannels()
    const oldSocket = attach(channels, () => true, "https://mcp.prismic.io")
    attach(channels, () => true, "http://localhost:4000")

    expect(channels.mcpOrigin(windowId)).toBe("http://localhost:4000")
    oldSocket.emit("close")
    expect(channels.mcpOrigin(windowId)).toBe("http://localhost:4000")
  })

  it("stops re-checking a socket that was replaced or closed", () => {
    vi.useFakeTimers()
    try {
      const channels = createWindowChannels()
      const isAuthorized = vi.fn(() => true)
      const oldSocket = attach(channels, isAuthorized)
      attach(channels)
      isAuthorized.mockClear()

      vi.advanceTimersByTime(180_000)

      expect(isAuthorized).not.toHaveBeenCalled()
      expect(oldSocket.closed).toEqual([{ code: 4000, reason: "replaced" }])
    } finally {
      vi.useRealTimers()
    }
  })
})
