import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { startBridgeServer } from "../bridgeServer.ts"
import type { BridgeServer } from "../bridgeServer.ts"
import { createPairing } from "../pairing.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { startOAuthStub } from "../testing/oauthStub.ts"
import type { OAuthStub } from "../testing/oauthStub.ts"
import { createWindowChannels } from "../windowChannels.ts"
import { editorContextRoutes } from "./editorContextRoutes.ts"
import { createMcpUpstream } from "./mcpUpstream.ts"
import { createPrismicAuth } from "./prismicAuth.ts"
import type { PrismicAuth } from "./prismicAuth.ts"

const editorOrigin = "http://localhost:5173"
const windowId = randomUUID()
const twoMiB = 2 * 1024 * 1024

let oauthStub: OAuthStub
let auth: PrismicAuth
let server: BridgeServer
let port: number
let token: string

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  oauthStub = await startOAuthStub()
  auth = await createPrismicAuth({ dataDir: "/nonexistent", port: 7878, stores: { store: createMemorySecretStore() } })
  const authorizeUrl = await auth.beginSignIn({ mcpOrigin: oauthStub.origin, onSignedIn: () => {}, onFailed: () => {} })
  const location = new URL((await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location") ?? "")
  const state = location.searchParams.get("state") ?? ""
  expect(await auth.handleCallback({ state, code: location.searchParams.get("code") ?? "" })).toBe("signed_in")

  const pairing = createPairing({})
  token = pairing.issueToken({ origin: editorOrigin, mcpOrigin: oauthStub.origin })
  port = await freePort()
  server = await startBridgeServer({
    port,
    extraOrigins: [editorOrigin],
    projectDir: "/tmp",
    providers: [],
    routes: editorContextRoutes({ prismicAuth: auth, upstream: createMcpUpstream({ auth }) }),
    pairing,
    prismicAuth: auth,
    channels: createWindowChannels(),
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
  await oauthStub.close()
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

interface Reply {
  status: number
  body: string
}

interface SendOptions {
  path?: string
  token?: string | null
  origin?: string | null
  userId?: string | null
  body?: string | Buffer
}

function send(method: "PUT" | "DELETE", options: SendOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? token}`
  if (options.origin !== null) headers.Origin = options.origin ?? editorOrigin
  if (options.userId !== null) headers["X-Prismic-User-Id"] = options.userId ?? "user-1"
  if (options.body !== undefined) headers["Content-Type"] = "application/json"
  return new Promise((resolve) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: options.path ?? `/editor-context/windows/${windowId}`, method, headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      },
    )
    request.on("error", () => resolve({ status: 0, body: "" }))
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

function errorOf(reply: Reply): string {
  return z.object({ error: z.string() }).parse(JSON.parse(reply.body)).error
}

function contextRequests() {
  return oauthStub.requests.filter((request) => request.path.startsWith("/editor-context/"))
}

// A JSON object of exactly `bytes` bytes.
function snapshotOfSize(bytes: number): Buffer {
  const wrapper = '{"padding":""}'
  return Buffer.from(`{"padding":"${"a".repeat(bytes - wrapper.length)}"}`)
}

describe("PUT /editor-context/windows/:windowId", () => {
  it("forwards the body untouched to the MCP server with the OAuth token", async () => {
    // Not what JSON.stringify would write: the daemon only forwards, it doesn't re-encode.
    const body = '{ "windowId":  "x",\n "title": "héllo \\u00e9 ✓", "n": 1.0 }'
    const accessToken = await auth.accessToken(oauthStub.origin)

    const reply = await send("PUT", { body })

    expect(reply.status).toBe(204)
    expect(reply.body).toBe("")
    const [forwarded, ...others] = contextRequests()
    expect(others).toEqual([])
    expect(forwarded).toMatchObject({ method: "PUT", path: `/editor-context/windows/${windowId}`, body })
    expect(forwarded?.headers.authorization).toBe(`Bearer ${accessToken}`)
    expect(forwarded?.headers["content-type"]).toBe("application/json")
    // The pairing token and the browser's identity claim stay on this side.
    expect(JSON.stringify(forwarded?.headers)).not.toContain(token)
    expect(forwarded?.headers["x-prismic-user-id"]).toBeUndefined()
    expect(forwarded?.headers.origin).toBeUndefined()
  })

  it("accepts a snapshot of exactly 2 MiB and refuses one byte more, before contacting the server", async () => {
    expect((await send("PUT", { body: snapshotOfSize(twoMiB) })).status).toBe(204)
    expect(contextRequests()).toHaveLength(1)

    const reply = await send("PUT", { body: snapshotOfSize(twoMiB + 1) })
    expect(reply.status).toBe(413)
    expect(contextRequests()).toHaveLength(1)
  })

  it.each([["[]"], ['"text"'], ["null"], ["42"], ["not json"], [""]])("refuses %j as a snapshot", async (body) => {
    const reply = await send("PUT", { body })
    expect(reply.status).toBe(400)
    expect(errorOf(reply)).toBe("invalid_request")
    expect(contextRequests()).toHaveLength(0)
  })

  it("refreshes the token and sends the same body again when the server no longer accepts it", async () => {
    const body = '{"windowId":"x"}'
    oauthStub.expireAccessTokens()

    expect((await send("PUT", { body })).status).toBe(204)

    const attempts = contextRequests()
    expect(attempts).toHaveLength(2)
    expect(attempts[1]?.body).toBe(body)
    expect(attempts[1]?.headers.authorization).not.toBe(attempts[0]?.headers.authorization)
  })
})

describe("DELETE /editor-context/windows/:windowId", () => {
  it("forwards the removal of the window", async () => {
    const reply = await send("DELETE")

    expect(reply.status).toBe(204)
    const [forwarded] = contextRequests()
    expect(forwarded).toMatchObject({ method: "DELETE", path: `/editor-context/windows/${windowId}`, body: "" })
    expect(forwarded?.headers.authorization).toBe(`Bearer ${await auth.accessToken(oauthStub.origin)}`)
  })
})

describe.each(["PUT", "DELETE"] as const)("%s: what the MCP server answers", (method) => {
  const body = method === "PUT" ? '{"windowId":"x"}' : undefined

  it.each([
    [204, 204, undefined],
    [413, 413, "payload_too_large"],
    [400, 400, "invalid_request"],
    [500, 502, "upstream_unavailable"],
    [404, 502, "upstream_unavailable"],
    [429, 502, "upstream_unavailable"],
  ])("%i becomes %i", async (upstreamStatus, status, error) => {
    oauthStub.editorContextStatus = upstreamStatus

    const reply = await send(method, { body })

    expect(reply.status).toBe(status)
    if (error !== undefined) expect(errorOf(reply)).toBe(error)
  })

  it("is 502 upstream_unavailable while the MCP server is down", async () => {
    await oauthStub.close()
    const reply = await send(method, { body })
    expect(reply.status).toBe(502)
    expect(errorOf(reply)).toBe("upstream_unavailable")
  })

  it("is 409 prismic_sign_in_required when the daemon is signed out", async () => {
    await auth.signOut(oauthStub.origin)
    const reply = await send(method, { body })
    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toBe("prismic_sign_in_required")
    expect(contextRequests()).toHaveLength(0)
  })

  it("is 409 prismic_sign_in_required when the sign-in turns out not to be renewable", async () => {
    oauthStub.expireAccessTokens()
    oauthStub.tokenBehavior = "invalid_grant"

    const reply = await send(method, { body })

    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toBe("prismic_sign_in_required")
    expect(auth.status(oauthStub.origin)).toEqual({ status: "signed_out" })
  })

  it.each([["another-user"], [null], [""]])("is 409 identity_mismatch when the browser says it is %j", async (userId) => {
    const reply = await send(method, { body, userId })

    expect(reply.status).toBe(409)
    expect(errorOf(reply)).toBe("identity_mismatch")
    expect(contextRequests()).toHaveLength(0)
  })

  it.each([
    ["a token used from an origin that may not pair at all", { origin: "https://evil.com" }, 403],
    ["a token used from an editor origin it wasn't issued for", { origin: "https://my-repo.prismic.io" }, 401],
    ["a token used without an origin", { origin: null }, 401],
    ["a wrong token", { token: "not-a-token" }, 401],
    ["no token", { token: null }, 401],
  ])("is refused with %s", async (_name, options, status) => {
    const reply = await send(method, { body, ...options })

    expect(reply.status).toBe(status)
    expect(contextRequests()).toHaveLength(0)
  })

  it.each([
    ["not-a-window-id"],
    [`${windowId}/extra`],
    [`${windowId}x`],
    [""],
  ])("does not route the window id %j", async (id) => {
    const reply = await send(method, { body, path: `/editor-context/windows/${id}` })

    expect(reply.status).toBe(404)
    expect(contextRequests()).toHaveLength(0)
  })
})
