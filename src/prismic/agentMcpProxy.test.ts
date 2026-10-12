import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { startBridgeServer } from "../bridgeServer.ts"
import type { BridgeServer } from "../bridgeServer.ts"
import { channelKey } from "../channelKey.ts"
import type { BridgeEvent } from "../protocol.ts"
import { createPairing } from "../pairing.ts"
import { createFakePrismic } from "../testing/fakePrismic.ts"
import { startStub } from "../testing/mcpStub.ts"
import type { Stub, StubMode } from "../testing/mcpStub.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { startOAuthStub } from "../testing/oauthStub.ts"
import type { OAuthStub } from "../testing/oauthStub.ts"
import type { WindowChannels } from "../windowChannels.ts"
import { agentMcpRoutes, createAgentMcpGrants } from "./agentMcpProxy.ts"
import type { AgentMcpGrants } from "./agentMcpProxy.ts"
import { createMcpUpstream } from "./mcpUpstream.ts"
import { createPrismicAuth } from "./prismicAuth.ts"
import type { PrismicAuth } from "./prismicAuth.ts"

const windowId = randomUUID()
const windowKey = channelKey(windowId, "claude")
const toolCall = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_editor_context", arguments: {} } }

const closers: Array<() => Promise<void>> = []

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
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

interface Notice {
  windowKey: string
  event: BridgeEvent
}

interface Proxy {
  port: number
  grants: AgentMcpGrants
  grant: string
  notices: Notice[]
  advance(ms: number): void
}

interface ProxyArgs {
  auth: PrismicAuth
  mcpOrigin: string
  // The account the agent's grant was issued for.
  userId?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

async function startProxy(args: ProxyArgs): Promise<Proxy> {
  const port = await freePort()
  const grants = createAgentMcpGrants()
  const notices: Notice[] = []
  let time = 1_000_000
  const channels: WindowChannels = {
    attach() {},
    mcpOrigin: () => undefined,
    send: (key, event) => void notices.push({ windowKey: key, event }),
    onMessage() {},
    onWindowClosed() {},
  }
  const server: BridgeServer = await startBridgeServer({
    port,
    extraOrigins: [],
    projectDir: "/tmp",
    providers: [],
    routes: agentMcpRoutes({
      grants,
      upstream: createMcpUpstream({ auth: args.auth }),
      prismicAuth: args.auth,
      channels,
      now: () => time,
      timeoutMs: args.timeoutMs,
      maxResponseBytes: args.maxResponseBytes,
    }),
    pairing: createPairing({}),
    prismicAuth: args.auth,
    channels,
  })
  closers.push(() => server.close())
  return { port, grants, grant: grants.issue({ mcpOrigin: args.mcpOrigin, windowKey, userId: args.userId ?? "user-1" }), notices, advance: (ms) => void (time += ms) }
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  // False when the connection was cut before the response ended.
  complete: boolean
}

function send(
  proxy: Proxy,
  options: { method?: string; token?: string | null; headers?: Record<string, string>; body?: string | Buffer | null } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? proxy.grant}`
  const body = options.body === undefined ? JSON.stringify(toolCall) : options.body
  if (body !== null && headers["Content-Type"] === undefined) headers["Content-Type"] = "application/json"
  return new Promise((resolve) => {
    const request = httpRequest({ host: "127.0.0.1", port: proxy.port, path: "/agent-mcp", method: options.method ?? "POST", headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("error", () => {})
      response.on("close", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), complete: response.complete }),
      )
    })
    request.on("error", () => resolve({ status: 0, headers: {}, body: "", complete: false }))
    if (body !== null) request.write(body)
    request.end()
  })
}

function errorOf(reply: Reply): string {
  return z.object({ error: z.string() }).parse(JSON.parse(reply.body)).error
}

// What the user's browser does at the authorize URL; the daemon ends up signed in to the stub.
async function signedInAuth(stub: OAuthStub): Promise<PrismicAuth> {
  const auth = await createPrismicAuth({ dataDir: "/nonexistent", port: 7878, stores: { store: createMemorySecretStore() } })
  await signIn(auth, stub)
  return auth
}

async function signIn(auth: PrismicAuth, stub: OAuthStub): Promise<void> {
  const url = await auth.beginSignIn({ mcpOrigin: stub.origin, onSignedIn: () => {}, onFailed: () => {} })
  const location = new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "")
  const state = location.searchParams.get("state") ?? ""
  expect(await auth.handleCallback({ state, code: location.searchParams.get("code") ?? "" })).toBe("signed_in")
}

describe("against an OAuth server", () => {
  let oauthStub: OAuthStub
  let auth: PrismicAuth
  let proxy: Proxy

  beforeEach(async () => {
    oauthStub = await startOAuthStub()
    closers.push(() => oauthStub.close())
    auth = await signedInAuth(oauthStub)
    proxy = await startProxy({ auth, mcpOrigin: oauthStub.origin })
  })

  it("forwards the agent's request with the OAuth access token, never with the grant", async () => {
    const accessToken = await auth.accessToken(oauthStub.origin)

    const reply = await send(proxy, {
      headers: { Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18", "X-Prismic-Window-Id": windowId, Cookie: "session=1", "X-Other": "1" },
    })

    expect(reply.status).toBe(200)
    expect(reply.headers["content-type"]).toContain("application/json")
    expect(JSON.parse(reply.body)).toMatchObject({ jsonrpc: "2.0", id: 7 })
    const [forwarded] = oauthStub.requestsTo("/mcp")
    expect(forwarded?.headers.authorization).toBe(`Bearer ${accessToken}`)
    expect(forwarded?.headers["x-prismic-window-id"]).toBe(windowId)
    expect(forwarded?.headers["mcp-protocol-version"]).toBe("2025-06-18")
    expect(JSON.parse(forwarded?.body ?? "{}")).toEqual(toolCall)
    // Only what the MCP protocol needs goes upstream.
    expect(forwarded?.headers.cookie).toBeUndefined()
    expect(forwarded?.headers["x-other"]).toBeUndefined()
    expect(JSON.stringify(oauthStub.requests.map((request) => request.headers))).not.toContain(proxy.grant)
  })

  it("does not forward a window id that isn't one", async () => {
    await send(proxy, { headers: { "X-Prismic-Window-Id": "../../admin" } })
    expect(oauthStub.requestsTo("/mcp")[0]?.headers["x-prismic-window-id"]).toBeUndefined()
  })

  it("refuses a missing, unknown or revoked grant, without inviting the agent to sign in on its own", async () => {
    const revoked = proxy.grants.issue({ mcpOrigin: oauthStub.origin, windowKey, userId: "user-1" })
    proxy.grants.revoke(revoked)

    for (const token of [null, "", "not-a-grant", revoked, await auth.accessToken(oauthStub.origin)]) {
      const reply = await send(proxy, { token })
      expect(reply.status).toBe(401)
      expect(errorOf(reply)).toBe("unauthorized")
      expect(reply.headers["www-authenticate"]).toBeUndefined()
    }
    expect(oauthStub.requestsTo("/mcp")).toHaveLength(0)
  })

  it("refuses any request that carries an Origin, even with a valid grant", async () => {
    for (const origin of ["https://evil.com", "http://localhost:5173", "null"]) {
      const reply = await send(proxy, { headers: { Origin: origin } })
      expect(reply.status).toBe(403)
      expect(errorOf(reply)).toBe("forbidden_origin")
    }
    expect(oauthStub.requestsTo("/mcp")).toHaveLength(0)
  })

  it.each(["GET", "PUT", "DELETE"])("answers %s with 405, whoever asks", async (method) => {
    const reply = await send(proxy, { method, body: null })
    expect(reply.status).toBe(405)
    expect(reply.headers.allow).toBe("POST")
    expect(oauthStub.requestsTo("/mcp")).toHaveLength(0)
  })

  it("refuses a request body over 1 MiB", async () => {
    const reply = await send(proxy, { body: Buffer.alloc(1024 * 1024 + 1, "a") })
    expect(reply.status).toBe(413)
    expect(oauthStub.requestsTo("/mcp")).toHaveLength(0)
  })

  it("refreshes the token and retries when the server no longer accepts it", async () => {
    const expired = await auth.accessToken(oauthStub.origin)
    oauthStub.expireAccessTokens()

    const reply = await send(proxy)

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toMatchObject({ id: 7 })
    const attempts = oauthStub.requestsTo("/mcp").map((request) => request.headers.authorization)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBe(`Bearer ${expired}`)
    expect(attempts[1]).not.toBe(attempts[0])
    expect(oauthStub.requestsTo("/mcp")[1]?.body).toBe(oauthStub.requestsTo("/mcp")[0]?.body)
    expect(proxy.notices).toEqual([])
  })

  it("answers 502 prismic_sign_in_required and tells the window when the sign-in can't be renewed", async () => {
    oauthStub.expireAccessTokens()
    oauthStub.tokenBehavior = "invalid_grant"

    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("prismic_sign_in_required")
    expect(proxy.notices).toEqual([
      { windowKey, event: { type: "notice", tone: "error", text: "Sign in to Prismic again from the agent panel." } },
    ])
    expect(auth.status(oauthStub.origin)).toEqual({ status: "signed_out" })
  })

  it("tells the window once per ten seconds, not once per agent request", async () => {
    oauthStub.expireAccessTokens()
    oauthStub.tokenBehavior = "invalid_grant"

    for (let request = 0; request < 3; request += 1) expect((await send(proxy)).status).toBe(502)
    expect(proxy.notices).toHaveLength(1)

    proxy.advance(10_000)
    expect((await send(proxy)).status).toBe(502)
    expect(proxy.notices).toHaveLength(2)
  })

  it("does not let an agent started as one account act as another that signed in since", async () => {
    await auth.signOut(oauthStub.origin)
    oauthStub.userId = "user-2"
    await signIn(auth, oauthStub)
    const mcpRequestsBefore = oauthStub.requestsTo("/mcp").length

    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("prismic_account_changed")
    expect(oauthStub.requestsTo("/mcp")).toHaveLength(mcpRequestsBefore)
    expect(proxy.notices).toEqual([
      { windowKey, event: { type: "notice", tone: "error", text: "The Prismic account changed. Send a message to restart the agent." } },
    ])

    // An agent started as the new account is served.
    const restarted = proxy.grants.issue({ mcpOrigin: oauthStub.origin, windowKey, userId: "user-2" })
    expect((await send(proxy, { token: restarted })).status).toBe(200)
  })

  it("tells the window about a changed account once per ten seconds", async () => {
    await auth.signOut(oauthStub.origin)
    oauthStub.userId = "user-2"
    await signIn(auth, oauthStub)

    for (let request = 0; request < 3; request += 1) expect(errorOf(await send(proxy))).toBe("prismic_account_changed")
    expect(proxy.notices).toHaveLength(1)

    proxy.advance(10_000)
    await send(proxy)
    expect(proxy.notices).toHaveLength(2)
  })

  it("asks for a sign-in, not an account change, when the daemon is signed out", async () => {
    await auth.signOut(oauthStub.origin)

    const reply = await send(proxy)

    expect(errorOf(reply)).toBe("prismic_sign_in_required")
    expect(proxy.notices.map((notice) => notice.event)).toEqual([
      { type: "notice", tone: "error", text: "Sign in to Prismic again from the agent panel." },
    ])
  })

  it("answers 502 upstream_unavailable, without a notice, while the server is down", async () => {
    const origin = oauthStub.origin
    await oauthStub.close()
    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("upstream_unavailable")
    expect(proxy.notices).toEqual([])
    expect(auth.status(origin)).toMatchObject({ status: "signed_in" })
  })
})

describe("against a misbehaving MCP server", () => {
  let mcp: Stub
  let origin: string

  async function proxyFor(mode: StubMode, args: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
    mcp = await startStub({ mode })
    closers.push(() => mcp.close())
    origin = new URL(mcp.url).origin
    const fake = createFakePrismic()
    return { fake, proxy: await startProxy({ auth: fake.auth, mcpOrigin: origin, ...args }) }
  }

  it("signs the daemon out when the server refuses the refreshed token too", async () => {
    const { fake, proxy } = await proxyFor("unauthorized")

    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("prismic_sign_in_required")
    expect(mcp.requests).toHaveLength(2)
    expect(proxy.notices.map((notice) => notice.windowKey)).toEqual([windowKey])
    expect(fake.auth.status(origin)).toEqual({ status: "signed_out" })
  })

  it("does not follow a redirect with the user's token", async () => {
    const { proxy } = await proxyFor("redirect")

    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("upstream_unavailable")
    expect(mcp.elsewhereHits).toBe(0)
  })

  it("cuts a response that is bigger than the limit", async () => {
    const { proxy } = await proxyFor("huge", { maxResponseBytes: 100 * 1024 })

    const reply = await send(proxy)

    expect(reply.complete).toBe(false)
    expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(100 * 1024)
  })

  it("passes a response within the limit as is", async () => {
    const { proxy } = await proxyFor("huge", { maxResponseBytes: 1024 * 1024 })

    const reply = await send(proxy)

    expect(reply.complete).toBe(true)
    expect(reply.status).toBe(200)
    expect(Buffer.byteLength(reply.body)).toBeGreaterThan(600 * 1024)
  })

  it("gives up on a server that never answers", async () => {
    const { proxy } = await proxyFor("hang", { timeoutMs: 100 })

    const reply = await send(proxy)

    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("upstream_unavailable")
    expect(proxy.notices).toEqual([])
  })
})
