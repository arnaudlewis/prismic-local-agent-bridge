import { mkdtempSync, readFileSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import { startBridgeServer } from "./bridgeServer.ts"
import type { BridgeServer } from "./bridgeServer.ts"
import { createPairing } from "./pairing.ts"
import type { ClientMessage } from "./protocol.ts"
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

const day = 24 * 60 * 60 * 1000
const hour = 60 * 60 * 1000

async function startServer(pairing: ReturnType<typeof createPairing>, recheckIntervalMs?: number) {
  const port = await freePort()
  const channels = createWindowChannels({ recheckIntervalMs })
  const received: ClientMessage[] = []
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
  return { port, received }
}

function pairToken(pairing: ReturnType<typeof createPairing>): string {
  const token = pairing.tryPair(pairing.currentCode())
  if (token === undefined) throw new Error("pairing failed")
  return token
}

async function openSocket(port: number, token: string): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}`, {
    headers: { Origin: origin },
  })
  const closed = new Promise<number>((resolve) => socket.once("close", resolve))
  await new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  return { socket, closed }
}

describe("a malformed frame while an unauthenticated socket is closing", () => {
  async function upgradeThenSendBadFrame(port: number, query: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const client = connect(port, "127.0.0.1", () => {
        client.write(
          [
            `GET /windows/${windowId}${query} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            `Origin: ${origin}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "",
            "",
          ].join("\r\n"),
        )
      })
      let sent = false
      client.on("data", (chunk) => {
        // Right after the 101, while the server is closing with 4401: an unmasked frame, which clients may not send.
        if (!sent && chunk.toString("latin1").includes("101")) {
          sent = true
          client.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]))
        }
      })
      client.on("error", () => {})
      client.on("close", () => resolve())
      setTimeout(() => {
        client.destroy()
        resolve()
      }, 500)
    })
  }

  it.each([["no token", ""], ["an invalid token", "?token=nope"]])(
    "does not crash the daemon (%s) and keeps serving /health",
    async (_name, query) => {
      const uncaught: Error[] = []
      const onUncaught = (error: Error) => uncaught.push(error)
      process.on("uncaughtException", onUncaught)
      try {
        const { port } = await startServer(createPairing({ onCodeChanged: () => {} }))

        await upgradeThenSendBadFrame(port, query)
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(uncaught).toEqual([])
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
      } finally {
        process.off("uncaughtException", onUncaught)
      }
    },
  )

  it("still closes with 4401 for an invalid token", async () => {
    const { port } = await startServer(createPairing({ onCodeChanged: () => {} }))
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=nope`, { headers: { Origin: origin } })

    const code = await new Promise<number>((resolve) => socket.once("close", resolve))

    expect(code).toBe(4401)
  })
})

describe("a socket whose pairing is gone", () => {
  it("is closed with 4401 and its message never dispatched once the pairing expired", async () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const { socket, closed } = await openSocket(port, token)

    socket.send(JSON.stringify({ type: "chat_cancel" }))
    await vi.waitFor(() => expect(received).toHaveLength(1))

    time += 31 * day
    socket.send(JSON.stringify({ type: "threads_list", repository: "repo" }))

    expect(await closed).toBe(4401)
    expect(received).toEqual([{ type: "chat_cancel" }])
  })

  it("is closed with 4401 and its message never dispatched when its pairing was evicted by a 21st browser", async () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })
    const evicted = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const { socket, closed } = await openSocket(port, evicted)
    for (let index = 0; index < 19; index++) {
      time += 1000
      pairToken(pairing)
    }
    expect(pairing.pairedBrowserCount()).toBe(20)

    // The socket's token is the least recently used of the 20 (its own activity would refresh it): the next pairing
    // evicts it.
    time += 1000
    pairToken(pairing)
    expect(pairing.pairedBrowserCount()).toBe(20)
    socket.send(JSON.stringify({ type: "threads_list", repository: "repo" }))

    expect(await closed).toBe(4401)
    expect(received).toEqual([])
  })

  it("keeps a valid pairing working and refreshes lastUsedAt from socket activity, at most once an hour", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-ws-pairing-"))
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time, dataDir })
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const { socket } = await openSocket(port, token)
    const lastUsedOnDisk = () =>
      (JSON.parse(readFileSync(join(dataDir, "pairing.json"), "utf8")) as { tokens: Array<{ lastUsedAt: number }> })
        .tokens[0]?.lastUsedAt

    time += 2 * hour
    socket.send(JSON.stringify({ type: "chat_cancel" }))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(lastUsedOnDisk()).toBe(time)

    const written = time
    time += 10_000
    socket.send(JSON.stringify({ type: "chat_cancel" }))
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(lastUsedOnDisk()).toBe(written)
  })

  it("closes idle sockets of an expired pairing at the periodic re-check", async () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })
    const token = pairToken(pairing)
    const { port } = await startServer(pairing, 50)
    const { closed } = await openSocket(port, token)

    time += 31 * day

    expect(await closed).toBe(4401)
  })
})
