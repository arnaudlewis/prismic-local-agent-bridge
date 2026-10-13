import { mkdtempSync, readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import type { AgentProvider, ProviderRoute } from "./agents/provider.ts"
import { startBridgeServer } from "./bridgeServer.ts"
import type { BridgeServer } from "./bridgeServer.ts"
import { createPairing } from "./pairing.ts"
import type { ClientMessage } from "./protocol.ts"
import { createFakePrismic } from "./testing/fakePrismic.ts"
import { createWindowChannels } from "./windowChannels.ts"

const origin = "http://localhost:5173"
const mcpOrigin = "https://mcp.prismic.io"
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
    const pairing = createPairing({})
    const channels = createWindowChannels()
    const received: unknown[] = []
    channels.onMessage((_windowId, message) => received.push(message))
    servers.push(
      await startBridgeServer({
        port,
        extraOrigins: [origin],
        projectDir: "/tmp",
        providers: [],
        routes: [],
        pairing,
        prismicAuth: createFakePrismic().auth,
        channels,
      }),
    )
    const token = pairToken(pairing)
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
  prismic = createFakePrismic(),
) {
  const port = await freePort()
  const channels = createWindowChannels({ recheckIntervalMs })
  const received: ClientMessage[] = []
  channels.onMessage((_windowId, message) => received.push(message))
  servers.push(
    await startBridgeServer({
      port,
      extraOrigins: [origin],
      projectDir: "/tmp",
      providers,
      routes: [],
      pairing,
      prismicAuth: prismic.auth,
      channels,
    }),
  )
  return { port, received, prismic, channels }
}

function pairToken(pairing: ReturnType<typeof createPairing>, browserOrigin = origin): string {
  return pairing.issueToken({ origin: browserOrigin, mcpOrigin })
}

async function openSocket(port: number, token: string, browserOrigin = origin): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}`, {
    headers: { Origin: browserOrigin },
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
        const { port } = await startServer(createPairing({}))

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
    const { port } = await startServer(createPairing({}))
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=nope`, { headers: { Origin: origin } })

    const code = await new Promise<number>((resolve) => socket.once("close", resolve))

    expect(code).toBe(4401)
  })

  it("closes with 4401 a valid token presented from another allowed origin than the one it was issued to", async () => {
    const pairing = createPairing({})
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}`, {
      headers: { Origin: "https://foo.prismic.io" },
    })
    socket.on("open", () => socket.send(JSON.stringify({ type: "chat_cancel" })))

    const code = await new Promise<number>((resolve) => socket.once("close", resolve))

    expect(code).toBe(4401)
    expect(received).toEqual([])
  })

  it("opens a socket from a deployed editor origin, and tells the channels the MCP origin it was paired with", async () => {
    const pairing = createPairing({})
    const deployed = "https://foo.prismic.io"
    const token = pairing.issueToken({ origin: deployed, mcpOrigin: "https://mcp.wroom.io" })
    const { port, received, channels } = await startServer(pairing)

    const { socket } = await openSocket(port, token, deployed)
    socket.send(JSON.stringify({ type: "chat_cancel" }))
    await vi.waitFor(() => expect(received).toHaveLength(1))

    expect(channels.mcpOrigin(`${windowId}/codex`)).toBe("https://mcp.wroom.io")
  })

  it("refuses the upgrade of a look-alike origin before any token is looked at", async () => {
    const pairing = createPairing({})
    const token = pairToken(pairing, "https://foo.prismic.io")
    const { port } = await startServer(pairing)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/windows/${windowId}?token=${token}`, {
      headers: { Origin: "https://www.prismic.io" },
    })

    const status = await new Promise<number | undefined>((resolve) => {
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode))
      socket.once("open", () => resolve(undefined))
      socket.once("error", () => {})
    })

    expect(status).toBe(403)
  })
})

describe("a socket whose pairing is gone", () => {
  it("is closed with 4401 and its message never dispatched once the pairing expired", async () => {
    let time = 1_000_000
    const pairing = createPairing({ now: () => time })
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
    const pairing = createPairing({ now: () => time })
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
    const pairing = createPairing({ now: () => time, dataDir })
    const token = pairToken(pairing)
    const { port, received } = await startServer(pairing)
    const { socket } = await openSocket(port, token)
    const lastUsedOnDisk = () =>
      (JSON.parse(readFileSync(join(dataDir, "pairing.json"), "utf8")) as { browsers: Array<{ lastUsedAt: number }> })
        .browsers[0]?.lastUsedAt

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
    const pairing = createPairing({ now: () => time })
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
  const pairing = createPairing({})
  const { port, prismic } = await startServer(pairing, undefined, providers)
  return { port, prismic, pairing, token: pairToken(pairing) }
}

function authorized(token: string, browserOrigin = origin): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${token}`, Origin: browserOrigin } }
}

describe("GET /status", () => {
  it("answers { projectDir, agents, prismic } to a paired browser", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])

    const response = await fetch(`http://127.0.0.1:${port}/status`, authorized(token))

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
      prismic: { status: "signed_in", userId: "user-1" },
    })
  })

  it("reports the Prismic sign-in of the MCP origin the browser was paired with", async () => {
    const { port, token, prismic } = await startWithProviders([])
    const status = async () => ((await (await fetch(`http://127.0.0.1:${port}/status`, authorized(token))).json()) as { prismic: unknown }).prismic

    prismic.setUserId("someone-else")
    expect(await status()).toEqual({ status: "signed_in", userId: "someone-else" })
    prismic.setUserId(undefined)
    expect(await status()).toEqual({ status: "signed_out" })
  })

  it("has no old top-level agentMode, model or chatgpt", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])

    const body = (await (await fetch(`http://127.0.0.1:${port}/status`, authorized(token))).json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(["agents", "prismic", "projectDir"])
  })

  it("needs a token", async () => {
    const { port } = await startWithProviders([fakeProvider()])

    expect((await fetch(`http://127.0.0.1:${port}/status`, { headers: { Origin: origin } })).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/status`, authorized("nope"))).status).toBe(401)
  })

  it("refuses a valid token presented with another origin, or none", async () => {
    const { port, token } = await startWithProviders([])

    // evil.com is refused before the token is looked at; the others are allowed origins the token was not issued to.
    expect((await fetch(`http://127.0.0.1:${port}/status`, authorized(token, "https://evil.com"))).status).toBe(403)
    expect((await fetch(`http://127.0.0.1:${port}/status`, authorized(token, "https://foo.prismic.io"))).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it("lists no agent when there is none", async () => {
    const { port, token } = await startWithProviders([])

    const response = await fetch(`http://127.0.0.1:${port}/status`, authorized(token))

    expect(await response.json()).toEqual({ projectDir: "/tmp", agents: {}, prismic: { status: "signed_in", userId: "user-1" } })
  })
})

describe("POST /prismic/sign-out", () => {
  it("signs the daemon out of Prismic for a paired browser", async () => {
    const { port, token, prismic } = await startWithProviders([])

    const response = await fetch(`http://127.0.0.1:${port}/prismic/sign-out`, { method: "POST", ...authorized(token) })

    expect(response.status).toBe(204)
    expect(prismic.auth.status(mcpOrigin)).toEqual({ status: "signed_out" })
  })

  it("does nothing without the bearer or from another origin", async () => {
    const { port, token, prismic } = await startWithProviders([])
    const url = `http://127.0.0.1:${port}/prismic/sign-out`

    expect((await fetch(url, { method: "POST", headers: { Origin: origin } })).status).toBe(401)
    expect((await fetch(url, { method: "POST", ...authorized("nope") })).status).toBe(401)
    expect((await fetch(url, { method: "POST", ...authorized(token, "https://foo.prismic.io") })).status).toBe(401)
    expect((await fetch(url, { method: "POST", ...authorized(token, "https://evil.com") })).status).toBe(403)

    expect(prismic.auth.status(mcpOrigin)).toEqual({ status: "signed_in", userId: "user-1" })
  })
})

describe("browser origins", () => {
  it("accepts a deployed editor origin, and refuses look-alikes, with and without a token", async () => {
    const pairing = createPairing({})
    const { port } = await startServer(pairing)
    const deployed = "https://foo.prismic.io"
    const token = pairToken(pairing, deployed)

    const paired = await fetch(`http://127.0.0.1:${port}/status`, authorized(token, deployed))
    expect(paired.status).toBe(200)
    expect(paired.headers.get("access-control-allow-origin")).toBe(deployed)

    for (const refused of ["https://www.prismic.io", "https://evil.com", "http://foo.prismic.io", "https://a.b.prismic.io"]) {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: refused } })
      expect(response.status, refused).toBe(403)
    }
    expect((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: deployed } })).status).toBe(200)
  })

  it("answers the preflight of a deployed editor with the user-id header allowed, and refuses a look-alike origin", async () => {
    const { port } = await startServer(createPairing({}))
    const preflight = (browserOrigin: string) =>
      fetch(`http://127.0.0.1:${port}/status`, {
        method: "OPTIONS",
        headers: { Origin: browserOrigin, "Access-Control-Request-Method": "GET" },
      })

    const allowed = await preflight("https://foo.prismic.io")
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-headers")).toContain("X-Prismic-User-Id")
    expect((await preflight("https://www.prismic.io")).status).toBe(403)
  })
})

describe("provider routes", () => {
  it("serves a bearer route only to a paired browser, from an allowed origin", async () => {
    const { port, token } = await startWithProviders([fakeProvider()])
    const url = `http://127.0.0.1:${port}/auth/fake/start`

    expect((await fetch(url, { method: "POST", headers: { Origin: origin } })).status).toBe(401)
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}` } })).status).toBe(403)
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://foo.prismic.io", Authorization: `Bearer ${token}` } })).status).toBe(401)
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

    for (const path of ["/auth/chatgpt/start", "/auth/chatgpt/sign-out", "/pair"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        ...authorized(token),
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
      ...authorized(token),
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
    const pairing = createPairing({})
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
    const pairing = createPairing({})
    const token = pairToken(pairing)
    const { port } = await startServer(pairing)
    const first = await connect(port, token, "&agent=claude")

    await connect(port, token, "&agent=claude")

    expect(await first.closed).toBe(4000)
  })

  it("treats a socket without an agent as a Codex one", async () => {
    const pairing = createPairing({})
    const token = pairToken(pairing)
    const { port } = await startServer(pairing)
    const without = await connect(port, token, "")

    await connect(port, token, "&agent=codex")

    expect(await without.closed).toBe(4000)
  })

  it("rejects an unknown agent before the upgrade", async () => {
    const pairing = createPairing({})
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
    const pairing = createPairing({})
    const token = pairToken(pairing)
    const port = await freePort()
    const channels = createWindowChannels()
    const keys: string[] = []
    channels.onMessage((key) => keys.push(key))
    servers.push(
      await startBridgeServer({
        port,
        extraOrigins: [origin],
        projectDir: "/tmp",
        providers: [],
        routes: [],
        pairing,
        prismicAuth: createFakePrismic().auth,
        channels,
      }),
    )
    const claude = await connect(port, token, "&agent=claude")

    claude.socket.send(JSON.stringify({ type: "chat_cancel" }))

    await vi.waitFor(() => expect(keys).toEqual([`${windowId}/claude`]))
  })

  it("keeps the authorization fence for each socket", async () => {
    let time = 1_000_000
    const pairing = createPairing({ now: () => time })
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

describe("telling whoever shows the accounts that one changed", () => {
  async function startWithCounter(routes: ProviderRoute[] = []) {
    const pairing = createPairing({})
    const port = await freePort()
    const calls: string[] = []
    servers.push(
      await startBridgeServer({
        port,
        extraOrigins: [origin],
        projectDir: "/tmp",
        providers: [],
        routes,
        pairing,
        prismicAuth: createFakePrismic().auth,
        channels: createWindowChannels(),
        onAccountsMayHaveChanged: () => calls.push("changed"),
      }),
    )
    return { port, token: pairToken(pairing), calls }
  }

  const signOutRoute: ProviderRoute = {
    method: "POST",
    path: "/auth/chatgpt/sign-out",
    auth: "bearer",
    handle: ({ res }) => {
      res.writeHead(204)
      res.end()
    },
  }
  const callbackRoute: ProviderRoute = {
    method: "GET",
    path: "/auth/callback",
    auth: "none",
    originExempt: true,
    handle: ({ res }) => {
      res.writeHead(200)
      res.end()
    },
  }
  const failingRoute: ProviderRoute = {
    method: "POST",
    path: "/auth/claude/key",
    auth: "bearer",
    handle: () => {
      throw new Error("the sign-in broke half way")
    },
  }

  it("does so after the sign-in and sign-out routes of the agents and of Prismic, which the page can reach", async () => {
    const { port, token, calls } = await startWithCounter([signOutRoute, callbackRoute])

    await fetch(`http://127.0.0.1:${port}/auth/chatgpt/sign-out`, { method: "POST", ...authorized(token) })
    expect(calls).toHaveLength(1)

    await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=y`)
    expect(calls).toHaveLength(2)

    await fetch(`http://127.0.0.1:${port}/prismic/sign-out`, { method: "POST", ...authorized(token) })
    expect(calls).toHaveLength(3)
  })

  it("does so even when the request failed: a sign-in that broke half way may have changed who is signed in", async () => {
    const { port, token, calls } = await startWithCounter([failingRoute])

    const response = await fetch(`http://127.0.0.1:${port}/auth/claude/key`, { method: "POST", ...authorized(token) })

    expect(response.status).toBe(500)
    expect(calls).toHaveLength(1)
  })

  it("does so for a request that was refused too, which costs nothing: the app throttles its own refresh", async () => {
    const { port, calls } = await startWithCounter([signOutRoute])

    const response = await fetch(`http://127.0.0.1:${port}/auth/chatgpt/sign-out`, { method: "POST", headers: { Origin: origin } })

    expect(response.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it("stays quiet for everything else: reading the status, the health, a preflight, an unknown path", async () => {
    const { port, token, calls } = await startWithCounter([signOutRoute])

    await fetch(`http://127.0.0.1:${port}/status`, authorized(token))
    await fetch(`http://127.0.0.1:${port}/health`)
    await fetch(`http://127.0.0.1:${port}/auth/chatgpt/sign-out`, { method: "OPTIONS", headers: { Origin: origin } })
    await fetch(`http://127.0.0.1:${port}/nothing-here`, authorized(token))

    expect(calls).toEqual([])
  })
})
