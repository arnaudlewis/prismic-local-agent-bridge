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

  close(): void {
    this.readyState = 3
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false)
  }
}

function attach(channels: ReturnType<typeof createWindowChannels>): FakeSocket {
  const socket = new FakeSocket()
  channels.attach(windowId, socket as unknown as WebSocket)
  return socket
}

describe("createWindowChannels", () => {
  it("ignores frames from a socket that was replaced, including permission_response and chat_reset", () => {
    const channels = createWindowChannels()
    const received: ClientMessage[] = []
    channels.onMessage((_windowId, message) => received.push(message))
    const oldSocket = attach(channels)
    const newSocket = attach(channels)

    oldSocket.receive({ type: "permission_response", requestId: "r1", optionId: "allow" })
    oldSocket.receive({ type: "chat_reset" })
    expect(received).toEqual([])

    newSocket.receive({ type: "chat_reset" })
    expect(received).toEqual([{ type: "chat_reset" }])
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
})
