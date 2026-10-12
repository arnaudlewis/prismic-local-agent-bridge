import type { WebSocket } from "ws"

import { ClientMessageSchema } from "./protocol.ts"
import type { BridgeEvent, ClientMessage } from "./protocol.ts"

const closeGraceMs = 15_000

type MessageListener = (windowId: string, message: ClientMessage) => void
type WindowClosedListener = (windowId: string) => void

export interface WindowChannels {
  attach(windowId: string, socket: WebSocket): void
  send(windowId: string, event: BridgeEvent): void
  onMessage(listener: MessageListener): void
  onWindowClosed(listener: WindowClosedListener): void
}

export function createWindowChannels(): WindowChannels {
  const sockets = new Map<string, WebSocket>()
  const graceTimers = new Map<string, NodeJS.Timeout>()
  const messageListeners: MessageListener[] = []
  const windowClosedListeners: WindowClosedListener[] = []

  function handleSocketMessage(windowId: string, data: string): void {
    const message = parseClientMessage(data)
    if (message === undefined) {
      console.warn(`Ignored invalid message from window ${windowId}`)
      return
    }
    for (const listener of messageListeners) listener(windowId, message)
  }

  function handleSocketClosed(windowId: string, socket: WebSocket): void {
    if (sockets.get(windowId) !== socket) return
    sockets.delete(windowId)
    const timer = setTimeout(() => {
      graceTimers.delete(windowId)
      for (const listener of windowClosedListeners) listener(windowId)
    }, closeGraceMs)
    timer.unref()
    graceTimers.set(windowId, timer)
  }

  return {
    attach(windowId, socket) {
      const graceTimer = graceTimers.get(windowId)
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer)
        graceTimers.delete(windowId)
      }
      const previous = sockets.get(windowId)
      sockets.set(windowId, socket)
      if (previous !== undefined) {
        // A replaced socket must not keep driving the session until it finishes closing.
        previous.removeAllListeners("message")
        previous.removeAllListeners("close")
        previous.on("error", () => {})
        previous.close(4000, "replaced")
      }

      socket.on("message", (data, isBinary) => {
        if (sockets.get(windowId) !== socket) return
        if (isBinary) {
          console.warn(`Ignored binary message from window ${windowId}`)
          return
        }
        handleSocketMessage(windowId, data.toString())
      })
      socket.on("close", () => handleSocketClosed(windowId, socket))
      socket.on("error", (error) => console.warn(`Socket error for window ${windowId}: ${error.message}`))
    },
    send(windowId, event) {
      const socket = sockets.get(windowId)
      if (socket === undefined || socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(event))
    },
    onMessage(listener) {
      messageListeners.push(listener)
    },
    onWindowClosed(listener) {
      windowClosedListeners.push(listener)
    },
  }
}

function parseClientMessage(data: string): ClientMessage | undefined {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return undefined
  }
  const parsed = ClientMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}
