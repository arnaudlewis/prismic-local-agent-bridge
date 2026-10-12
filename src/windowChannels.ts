import type { WebSocket } from "ws"

import { ClientMessageSchema } from "./protocol.ts"
import type { BridgeEvent, ClientMessage } from "./protocol.ts"

const closeGraceMs = 15_000
const recheckIntervalMs = 60_000

type MessageListener = (windowId: string, message: ClientMessage) => void
type WindowClosedListener = (windowId: string) => void

export interface WindowAccess {
  // Called before every inbound message and periodically; once it returns false the socket is closed.
  isAuthorized(): boolean
  // The Prismic MCP origin of the pairing this socket authenticated with.
  mcpOrigin: string
}

export interface WindowChannels {
  attach(windowId: string, socket: WebSocket, access: WindowAccess): void
  // The Prismic MCP origin of the window's current socket, while it is attached.
  mcpOrigin(windowId: string): string | undefined
  send(windowId: string, event: BridgeEvent): void
  onMessage(listener: MessageListener): void
  onWindowClosed(listener: WindowClosedListener): void
}

interface CreateWindowChannelsArgs {
  // Only tests change it.
  recheckIntervalMs?: number
}

export function createWindowChannels(args: CreateWindowChannelsArgs = {}): WindowChannels {
  const recheckMs = args.recheckIntervalMs ?? recheckIntervalMs
  const sockets = new Map<string, WebSocket>()
  const mcpOrigins = new Map<string, string>()
  const recheckTimers = new Map<WebSocket, NodeJS.Timeout>()
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

  function stopRecheck(socket: WebSocket): void {
    clearInterval(recheckTimers.get(socket))
    recheckTimers.delete(socket)
  }

  function handleSocketClosed(windowId: string, socket: WebSocket): void {
    if (sockets.get(windowId) !== socket) return
    sockets.delete(windowId)
    mcpOrigins.delete(windowId)
    const timer = setTimeout(() => {
      graceTimers.delete(windowId)
      for (const listener of windowClosedListeners) listener(windowId)
    }, closeGraceMs)
    timer.unref()
    graceTimers.set(windowId, timer)
  }

  return {
    attach(windowId, socket, access) {
      const { isAuthorized } = access
      mcpOrigins.set(windowId, access.mcpOrigin)
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
        stopRecheck(previous)
        previous.close(4000, "replaced")
      }

      // Returns false (and closes the socket) when the pairing behind it is gone.
      const stillAuthorized = () => {
        if (isAuthorized()) return true
        stopRecheck(socket)
        socket.close(4401, "unauthorized")
        return false
      }
      const timer = setInterval(stillAuthorized, recheckMs)
      timer.unref()
      recheckTimers.set(socket, timer)

      socket.on("message", (data, isBinary) => {
        if (sockets.get(windowId) !== socket) return
        if (!stillAuthorized()) return
        if (isBinary) {
          console.warn(`Ignored binary message from window ${windowId}`)
          return
        }
        handleSocketMessage(windowId, data.toString())
      })
      socket.on("close", () => {
        stopRecheck(socket)
        handleSocketClosed(windowId, socket)
      })
      socket.on("error", (error) => console.warn(`Socket error for window ${windowId}: ${error.message}`))
    },
    mcpOrigin: (windowId) => mcpOrigins.get(windowId),
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
