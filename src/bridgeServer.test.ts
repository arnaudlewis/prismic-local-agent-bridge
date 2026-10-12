import { mkdtempSync, readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentProvider } from "./agents/provider.ts"
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
        providers: [],
        pairing,
        channels,
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

async function startServer(
  pairing: ReturnType<typeof createPairing>,
  recheckIntervalMs?: number,
  providers: AgentProvider[] = [],
) {
  const port = await freePort()
  const channels = createWindowChannels({ recheckIntervalMs })
  const received: ClientMessage[] = []
  channels.onMessage((_windowId, message) => received.push(message))
  servers.push(
    await startBridgeServer({
      port,
      allowedOrigins: [origin],
      projectDir: "/tmp",
      providers,
      pairing,
      channels,
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
    socket.send(JSON.stringify({ type: "threads_list", repository: "repo", agent: "codex" }))

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
    socket.send(JSON.stringify({ type: "threads_list", repository: "repo", agent: "codex" }))

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

function fakeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    id: "codex",
    label: "Fake",
    blockedCommands: [],
    hiddenCommands: [],
    protectedConfigIds: [],
    sessionRestartedNotice: "",
    authenticate: () => Promise.resolve({ fingerprint: "", env: {} }),
    spawnSpec: () => ({ command: "", args: [], env: {} }),
    nativeCommandName: () => undefined,
    identifyToolCall: () => undefined,
    readToolResult: () => undefined,
    getStatus: () => ({
      agentMode: "read-only",
      model: "gpt-x",
      account: { kind: "chatgpt", status: "signed_in", email: "me@example.com", planUsage: true },
    }),
    bannerLines: () => [],
    routes: () => [
      {
        method: "POST",
        path: "/auth/fake/start",
        auth: "bearer",
        handle: ({ res }) => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end('{"started":true}')
        },
      },
      {
        method: "GET",
        path: "/auth/fake/callback",
        auth: "none",
        originExempt: true,
        handle: ({ res, url }) => {
          res.writeHead(200, { "Content-Type": "text/plain" })
          res.end(`state=${url.searchParams.get("state")}`)
        },
      },
    ],
    ...overrides,
  }
}

async function startWithProviders(providers: AgentProvider[]) {
  const pairing = createPairing({ onCodeChanged: () => {} })
  const { port } = await startServer(pairing, undefined, providers)
  return { port, token: pairToken(pairing) }
}

describe("GET /status", () => {
  it("answers { projectDir, agents: { codex: { agentMode, model?, account } } } to a paired browser", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])

    const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${token}` } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      projectDir: "/tmp",
      agents: {
        codex: {
          agentMode: "read-only",
          model: "gpt-x",
          account: { kind: "chatgpt", status: "signed_in", email: "me@example.com", planUsage: true },
        },
      },
    })
  })

  it("has no old top-level agentMode, model or chatgpt", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])

    const body = (await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(["agents", "projectDir"])
  })

  it("needs a token", async () => {
    const { port } = await startWithProviders([fakeProvider()])

    expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401)
  })

  it("lists no agent when there is none", async () => {
    const { port, token } = await startWithProviders([])

    const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${token}` } })

    expect(await response.json()).toEqual({ projectDir: "/tmp", agents: {} })
  })
})

describe("provider routes", () => {
  it("serves a bearer route only to a paired browser, from an allowed origin", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])
    const url = `http://127.0.0.1:${port}/auth/fake/start`

    expect((await fetch(url, { method: "POST" })).status).toBe(401)
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}` } })).status).toBe(403)
    const ok = await fetch(url, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}` } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ started: true })
  })

  it("serves an origin-exempt route without a token or an allowed origin (sign-in redirects)", async () => {
    const { port } = await startWithProviders([fakeProvider()])

    const response = await fetch(`http://127.0.0.1:${port}/auth/fake/callback?state=abc`, {
      headers: { Origin: "https://auth.example" },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("state=abc")
  })

  it("still checks the Host header on provider routes", async () => {
    const { port } = await startWithProviders([fakeProvider()])

    const status = await new Promise<number | undefined>((resolve) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path: "/auth/fake/callback", headers: { Host: "evil.example" } },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        },
      )
      request.end()
    })

    expect(status).toBe(403)
  })

  it("answers 404 for a route no provider registered, and for the old per-agent paths without a provider", async () => {
    const { port, token } = await startWithProviders([])

    for (const path of ["/auth/chatgpt/start", "/auth/chatgpt/sign-out"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(404)
    }
  })

  it("lets a provider route fail without taking the daemon down", async () => {
    const { port, token } = await startWithProviders([
      fakeProvider({
        routes: () => [
          {
            method: "POST",
            path: "/auth/fake/start",
            auth: "bearer",
            handle: () => Promise.reject(new Error("boom")),
          },
        ],
      }),
    ])
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await fetch(`http://127.0.0.1:${port}/auth/fake/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "internal_error" })
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    error.mockRestore()
  })
})

describe("one socket per window and agent", () => {
  async function connect(port: number, token: string, query: string): Promise<{ socket: WebSocket; closed: Promise<number> }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}${query}`, {
      headers: { Origin: origin },
    })
    const closed = new Promise<number>((resolve) => socket.once("close", resolve))
    await new Promise((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    return { socket, closed }
  }

  it("keeps the Codex and the Claude socket of the same window open side by side", async () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const codex = await connect(port, token, "&agent=codex")
    const claude = await connect(port, token, "&agent=claude")

    codex.socket.send(JSON.stringify({ type: "chat_cancel" }))
    claude.socket.send(JSON.stringify({ type: "chat_cancel" }))
    await vi.waitFor(() => expect(received).toHaveLength(2))

    expect(codex.socket.readyState).toBe(WebSocket.OPEN)
    expect(claude.socket.readyState).toBe(WebSocket.OPEN)
  })

  it("still replaces a second socket for the same window and agent", async () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairToken(pairing)
    const { port } = await startServer(pairing)
    const first = await connect(port, token, "&agent=claude")

    await connect(port, token, "&agent=claude")

    expect(await first.closed).toBe(4000)
  })

  it("treats a socket without an agent as a Codex one", async () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairToken(pairing)
    const { port } = await startServer(pairing)
    const without = await connect(port, token, "")

    await connect(port, token, "&agent=codex")

    expect(await without.closed).toBe(4000)
  })

  it("rejects an unknown agent before the upgrade", async () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairToken(pairing)
    const { port } = await startServer(pairing)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}&agent=gemini`, {
      headers: { Origin: origin },
    })

    const status = await new Promise<number | undefined>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode))
      socket.once("open", () => resolve(undefined))
      socket.once("error", () => {})
    })

    expect(status).toBe(400)
  })

  it("reports messages under a key that holds both the window and the agent", async () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairToken(pairing)
    const port = await freePort()
    const channels = createWindowChannels()
    const keys: string[] = []
    channels.onMessage((key) => keys.push(key))
    servers.push(
      await startBridgeServer({ port, allowedOrigins: [origin], projectDir: "/tmp", providers: [], pairing, channels }),
    )
    const claude = await connect(port, token, "&agent=claude")

    claude.socket.send(JSON.stringify({ type: "chat_cancel" }))

    await vi.waitFor(() => expect(keys).toEqual([`${windowId}/claude`]))
  })

  it("keeps the authorization fence for each socket", async () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const claude = await connect(port, token, "&agent=claude")
    const codex = await connect(port, token, "&agent=codex")

    time += 31 * day
    claude.socket.send(JSON.stringify({ type: "chat_cancel" }))
    codex.socket.send(JSON.stringify({ type: "chat_cancel" }))

    expect(await claude.closed).toBe(4401)
    expect(await codex.closed).toBe(4401)
    expect(received).toEqual([])
  })
})
