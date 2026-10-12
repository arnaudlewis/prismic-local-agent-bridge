import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"

import { startBridgeServer } from "./bridgeServer.ts"
import type { BridgeServer } from "./bridgeServer.ts"
import { createPairing } from "./pairing.ts"
import { createWindowChannels } from "./windowChannels.ts"

const origin = "http://localhost:5173"
const windowId = "11111111-1111-4111-8111-111111111111"
const servers: BridgeServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

describe("websocket frames", () => {
  it("closes a connection that sends a frame over 256 KiB, and delivers a normal one", async () => {
    const port = await freePort()
    const pairing = createPairing({ onCodeChanged: () => {} })
    const channels = createWindowChannels()
    const received: unknown[] = []
    channels.onMessage((_windowId, message) => received.push(message))
    servers.push(
      await startBridgeServer({
        port,
        allowedOrigins: [origin],
        projectDir: "/tmp",
        agentMode: "read-only",
        model: undefined,
        pairing,
        channels,
        auth: {} as never,
      }),
    )
    const token = pairing.tryPair(pairing.currentCode())
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}`, { headers: { Origin: origin } })
    await new Promise((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })

    socket.send(JSON.stringify({ type: "chat_cancel" }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received).toEqual([{ type: "chat_cancel" }])

    const closed = new Promise<number>((resolve) => socket.once("close", resolve))
    socket.send("x".repeat(300 * 1024))

    expect(await closed).toBe(1009)
  })
})
