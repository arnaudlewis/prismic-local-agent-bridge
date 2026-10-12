import { createHash, randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { startBridgeServer } from "../bridgeServer.ts"
import type { BridgeServer } from "../bridgeServer.ts"
import { createPairing } from "../pairing.ts"
import { createPrismicAuth } from "../prismic/prismicAuth.ts"
import type { PrismicAuth } from "../prismic/prismicAuth.ts"
import { createRateLimiter } from "../rateLimit.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { startOAuthStub } from "../testing/oauthStub.ts"
import type { OAuthStub } from "../testing/oauthStub.ts"
import { createWindowChannels } from "../windowChannels.ts"
import { connectRateLimit, connectRoutes } from "./connectRoutes.ts"
import { attemptTtlMs, createPendingConnections } from "./pendingConnections.ts"
import type { PendingConnections } from "./pendingConnections.ts"

const editorOrigin = "http://localhost:5173"
const deployedOrigin = "https://foo.prismic.io"
const servers: BridgeServer[] = []
const stubs: OAuthStub[] = []

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const stub of stubs.splice(0)) await stub.close()
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

interface Daemon {
  port: number
  stub: OAuthStub
  clock: { time: number }
  pending: PendingConnections
  prismicAuth: PrismicAuth
}

async function startDaemon(args: { projectDir?: string } = {}): Promise<Daemon> {
  const stub = await startOAuthStub()
  stubs.push(stub)
  const port = await freePort()
  const clock = { time: 1_000_000 }
  const now = () => clock.time
  const prismicAuth = await createPrismicAuth({ dataDir: "/tmp", port, now, stores: { store: createMemorySecretStore() } })
  const pending = createPendingConnections({ now })
  const pairing = createPairing({ now })
  const extraOrigins = [editorOrigin]
  const projectDir = args.projectDir ?? "/work/site"
  const routes = connectRoutes({
    pending,
    pairing,
    prismicAuth,
    extraOrigins,
    port,
    projectDir,
    limiter: createRateLimiter({ ...connectRateLimit, now }),
  })
  servers.push(
    await startBridgeServer({ port, extraOrigins, projectDir, providers: [], routes, pairing, prismicAuth, channels: createWindowChannels() }),
  )
  return { port, stub, clock, pending, prismicAuth }
}

interface Reply {
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}

function send(
  daemon: Daemon,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: daemon.port, path, method, headers: options.headers ?? {} }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }),
      )
    })
    request.on("error", reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

// What the Page Builder holds: the secret stays with it, the challenge goes into the popup's URL.
function newSecret(): { secret: string; challenge: string } {
  const secret = randomBytes(32).toString("base64url")
  return { secret, challenge: createHash("sha256").update(secret).digest("base64url") }
}

interface ConnectArgs {
  origin?: string
  mcp?: string
  challenge?: string
}

function connectPath(daemon: Daemon, args: ConnectArgs): string {
  const query = new URLSearchParams()
  if (args.origin !== undefined) query.set("origin", args.origin)
  query.set("mcp", args.mcp ?? daemon.stub.origin)
  if (args.challenge !== undefined) query.set("challenge", args.challenge)
  return `/connect?${query.toString()}`
}

function openConnect(daemon: Daemon, args: ConnectArgs): Promise<Reply> {
  return send(daemon, "GET", connectPath(daemon, args))
}

function attemptIdOf(consent: Reply): string {
  const id = /name="attempt" value="([^"]+)"/.exec(consent.body)?.[1]
  if (id === undefined) throw new Error(`no consent form in the page: ${consent.body}`)
  return id
}

function decide(daemon: Daemon, fields: Record<string, string>, headers?: Record<string, string>): Promise<Reply> {
  return send(daemon, "POST", "/connect/decision", {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://127.0.0.1:${daemon.port}`, ...headers },
    body: new URLSearchParams(fields).toString(),
  })
}

const ClaimReplySchema = z.object({ status: z.string().optional(), token: z.string().optional(), error: z.string().optional() })

interface ClaimReply {
  status: number
  json: z.infer<typeof ClaimReplySchema>
  headers: Reply["headers"]
}

async function claim(daemon: Daemon, secret: string, origin: string | null = editorOrigin): Promise<ClaimReply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (origin !== null) headers.Origin = origin
  const reply = await send(daemon, "POST", "/pair/claim", { headers, body: JSON.stringify({ secret }) })
  return { status: reply.status, json: ClaimReplySchema.parse(JSON.parse(reply.body)), headers: reply.headers }
}

const StatusSchema = z.object({ prismic: z.unknown() })

function prismicOf(status: Reply): unknown {
  return StatusSchema.parse(JSON.parse(status.body)).prismic
}

// Opens the popup and answers the consent page with "allow", like the user does.
async function allow(daemon: Daemon, args: ConnectArgs & { challenge: string }): Promise<Reply> {
  const consent = await openConnect(daemon, { origin: editorOrigin, ...args })
  return decide(daemon, { attempt: attemptIdOf(consent), decision: "allow" })
}

// The sign-in the popup chains to: the stub's authorize endpoint answers with a redirect to the daemon's callback.
async function authorizeAt(authorizeUrl: string): Promise<{ callbackPath: string; state: string }> {
  const response = await fetch(authorizeUrl, { redirect: "manual" })
  const callback = new URL(response.headers.get("location") ?? "")
  return { callbackPath: `${callback.pathname}${callback.search}`, state: callback.searchParams.get("state") ?? "" }
}

async function signIn(daemon: Daemon): Promise<void> {
  const authorizeUrl = await daemon.prismicAuth.beginSignIn({ mcpOrigin: daemon.stub.origin, onSignedIn: () => {}, onFailed: () => {} })
  const { callbackPath } = await authorizeAt(authorizeUrl)
  const callback = new URL(callbackPath, "http://127.0.0.1")
  const outcome = await daemon.prismicAuth.handleCallback({
    state: callback.searchParams.get("state") ?? "",
    code: callback.searchParams.get("code") ?? undefined,
  })
  expect(outcome).toBe("signed_in")
}

function header(reply: Reply, name: string): string {
  const value = reply.headers[name]
  return Array.isArray(value) ? value.join(", ") : (value ?? "")
}

describe("GET /connect", () => {
  it("serves the consent page with headers that keep it unframed, unscripted and uncached", async () => {
    const daemon = await startDaemon()

    const reply = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })

    expect(reply.status).toBe(200)
    expect(header(reply, "content-type")).toBe("text/html; charset=utf-8")
    expect(header(reply, "x-frame-options")).toBe("DENY")
    expect(header(reply, "cross-origin-opener-policy")).toBe("same-origin")
    expect(header(reply, "referrer-policy")).toBe("no-referrer")
    expect(header(reply, "cache-control")).toBe("no-store")
    expect(header(reply, "x-content-type-options")).toBe("nosniff")
    const policy = header(reply, "content-security-policy")
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain("form-action")
    expect(policy).not.toContain("unsafe-inline")
  })

  it("allows its own inline style and script through hashes of exactly what the page carries", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    await signIn(daemon)
    const connected = await allow(daemon, { challenge })

    const style = /<style>([\s\S]*?)<\/style>/.exec(connected.body)?.[1] ?? ""
    const script = /<script>([\s\S]*?)<\/script>/.exec(connected.body)?.[1] ?? ""

    const policy = header(connected, "content-security-policy")
    expect(style).not.toBe("")
    expect(script).not.toBe("")
    expect(policy).toContain(`style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`)
    expect(policy).toContain(`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`)
    expect((await claim(daemon, secret)).json.status).toBe("approved")
  })

  it("escapes the project directory, and carries no script on the consent page", async () => {
    const daemon = await startDaemon({ projectDir: `/work/<script>alert(1)</script>"><img src=x>` })

    const reply = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })

    expect(reply.body).not.toContain("<script")
    expect(reply.body).not.toContain("<img")
    expect(reply.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("names the repository of a deployed editor, and none for a local one", async () => {
    const daemon = await startDaemon()

    const deployed = await openConnect(daemon, { origin: deployedOrigin, challenge: newSecret().challenge })
    const local = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })

    expect(deployed.body).toContain(`<code>${deployedOrigin}</code> (repository <strong>foo</strong>)`)
    expect(local.body).not.toContain("repository")
  })

  it("tells a signed-out user about the sign-in that follows, and a signed-in one doesn't hear of it", async () => {
    const daemon = await startDaemon()
    const signedOut = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })
    await signIn(daemon)

    const signedIn = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })

    expect(signedOut.body).toContain("You'll sign in to Prismic next.")
    expect(signedOut.body).toContain("Allow and sign in")
    expect(signedIn.body).not.toContain("sign in")
    expect(signedIn.body).toContain(">Allow</button>")
  })

  it("asks to sign in again for an MCP origin it has no sign-in for, even when it has one for another", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const otherMcp = daemon.stub.origin.replace("127.0.0.1", "localhost")

    const reply = await openConnect(daemon, { origin: editorOrigin, mcp: otherMcp, challenge: newSecret().challenge })

    expect(reply.body).toContain("Allow and sign in")
  })

  it.each([
    ["a foreign site", "https://evil.com"],
    ["the marketing site", "https://www.prismic.io"],
    ["a reserved label", "https://docs.prismic.io"],
    ["two labels under the domain", "https://a.b.prismic.io"],
    ["a plain-http deployed host", "http://foo.prismic.io"],
    ["a lookalike of the domain", "https://foo.prismic.io.evil.com"],
    ["a local origin on another port", "http://localhost:5174"],
    ["no origin at all", ""],
  ])("refuses %s as the web page to connect", async (_name, origin) => {
    const daemon = await startDaemon()
    const { challenge } = newSecret()

    const reply = await openConnect(daemon, { origin, challenge })

    expect(reply.status).toBe(400)
    expect(reply.body).toContain("This web page isn&#39;t one the local agent connects to.")
    expect(reply.body).not.toContain('name="attempt"')
    expect(daemon.pending.byChallenge(challenge)).toBeUndefined()
  })

  it.each([
    ["a foreign server", "https://evil.com"],
    ["a lookalike of the production MCP", "https://mcp.prismic.io.evil.com"],
    ["plain http for a remote host", "http://mcp.prismic.io"],
    ["no value", ""],
  ])("refuses %s as the MCP server", async (_name, mcp) => {
    const daemon = await startDaemon()
    const { challenge } = newSecret()

    const reply = await openConnect(daemon, { origin: editorOrigin, mcp, challenge })

    expect(reply.status).toBe(400)
    expect(reply.body).not.toContain('name="attempt"')
    expect(daemon.pending.byChallenge(challenge)).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["too short", "abc"],
    ["too long", "a".repeat(44)],
    ["not base64url", `${"a".repeat(42)}+`],
  ])("refuses a challenge that is %s", async (_name, challenge) => {
    const daemon = await startDaemon()

    const reply = await openConnect(daemon, { origin: editorOrigin, challenge })

    expect(reply.status).toBe(400)
    expect(reply.body).not.toContain('name="attempt"')
  })

  it("serves the same attempt to a popup that is reloaded, and refuses the challenge for another origin or MCP", async () => {
    const daemon = await startDaemon()
    const { challenge } = newSecret()
    const first = await openConnect(daemon, { origin: editorOrigin, challenge })

    const reloaded = await openConnect(daemon, { origin: editorOrigin, challenge })
    const otherOrigin = await openConnect(daemon, { origin: deployedOrigin, challenge })
    const otherMcp = await openConnect(daemon, { origin: editorOrigin, mcp: daemon.stub.origin.replace("127.0.0.1", "localhost"), challenge })

    expect(attemptIdOf(reloaded)).toBe(attemptIdOf(first))
    expect(otherOrigin.status).toBe(400)
    expect(otherMcp.status).toBe(400)
  })

  it("shows the answer, not the question again, when the popup is reloaded after the user decided", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const approved = newSecret()
    const denied = newSecret()
    await allow(daemon, approved)
    const consent = await openConnect(daemon, { origin: editorOrigin, challenge: denied.challenge })
    await decide(daemon, { attempt: attemptIdOf(consent), decision: "deny" })

    const afterApproval = await openConnect(daemon, { origin: editorOrigin, challenge: approved.challenge })
    const afterDenial = await openConnect(daemon, { origin: editorOrigin, challenge: denied.challenge })

    expect(afterApproval.body).toContain("<h1>Connected</h1>")
    expect(afterDenial.body).toContain("<h1>Connection canceled</h1>")
    expect(afterApproval.body).not.toContain('name="attempt"')
    expect(afterDenial.body).not.toContain('name="attempt"')
  })

  it("answers the 21st request within a minute with a 429 page, and serves again once the minute has passed", async () => {
    const daemon = await startDaemon()
    const statuses: number[] = []
    for (let index = 0; index < 20; index += 1) {
      statuses.push((await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })).status)
    }

    const limited = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })
    daemon.clock.time += 60_000
    const later = await openConnect(daemon, { origin: editorOrigin, challenge: newSecret().challenge })

    expect(statuses.every((status) => status === 200)).toBe(true)
    expect(limited.status).toBe(429)
    expect(limited.body).toContain("Too many requests. Try again in a minute.")
    expect(limited.body).not.toContain('name="attempt"')
    expect(later.status).toBe(200)
  })

  it("counts refused requests too, and leaves the consent decision and the polling out of the limit", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    const consent = await openConnect(daemon, { origin: editorOrigin, challenge })
    for (let index = 0; index < 19; index += 1) await openConnect(daemon, { origin: "https://evil.com", challenge })

    const limited = await openConnect(daemon, { origin: editorOrigin, challenge })
    const polled = await claim(daemon, secret)
    const denied = await decide(daemon, { attempt: attemptIdOf(consent), decision: "deny" })

    expect(limited.status).toBe(429)
    expect(polled.json.status).toBe("pending")
    expect(denied.status).toBe(200)
  })
})

describe("POST /connect/decision", () => {
  async function awaitingConsent(daemon: Daemon) {
    const { secret, challenge } = newSecret()
    const attemptId = attemptIdOf(await openConnect(daemon, { origin: editorOrigin, challenge }))
    return { secret, attemptId }
  }

  it.each([
    ["no Origin header", () => ({})],
    ["the Page Builder's origin", () => ({ Origin: editorOrigin })],
    ["a foreign origin", () => ({ Origin: "https://evil.com" })],
    ["the daemon's host on another port", () => ({ Origin: "http://127.0.0.1:1" })],
    ["a cross-site fetch", (port: number) => ({ Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "cross-site" })],
    ["a same-site fetch", (port: number) => ({ Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-site" })],
  ])("refuses a decision from %s, and the attempt stays undecided", async (_name, headersFor) => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, attemptId } = await awaitingConsent(daemon)

    const reply = await send(daemon, "POST", "/connect/decision", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headersFor(daemon.port) },
      body: new URLSearchParams({ attempt: attemptId, decision: "allow" }).toString(),
    })

    expect(reply.status).toBe(403)
    expect(reply.body).toContain("This request didn&#39;t come from the consent page.")
    expect((await claim(daemon, secret)).json.status).toBe("pending")
  })

  it("accepts the form posted from either spelling of the daemon's own origin", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, attemptId } = await awaitingConsent(daemon)

    const reply = await decide(daemon, { attempt: attemptId, decision: "allow" }, { Origin: `http://localhost:${daemon.port}`, "Sec-Fetch-Site": "same-origin" })

    expect(reply.status).toBe(200)
    expect((await claim(daemon, secret)).json.status).toBe("approved")
  })

  it("answers an unknown attempt with the expired page", async () => {
    const daemon = await startDaemon()

    const reply = await decide(daemon, { attempt: "nope", decision: "allow" })

    expect(reply.status).toBe(400)
    expect(reply.body).toContain("This request has expired. Start again from the Page Builder.")
  })

  it("answers an attempt older than ten minutes with the expired page, and the Page Builder with `expired`", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, attemptId } = await awaitingConsent(daemon)
    daemon.clock.time += attemptTtlMs + 1

    const reply = await decide(daemon, { attempt: attemptId, decision: "allow" })

    expect(reply.status).toBe(400)
    expect(reply.body).toContain("This request has expired.")
    expect((await claim(daemon, secret)).json.status).toBe("expired")
  })

  it("refuses an answer that is neither allow nor deny", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, attemptId } = await awaitingConsent(daemon)

    const reply = await decide(daemon, { attempt: attemptId, decision: "maybe" })

    expect(reply.status).toBe(400)
    expect((await claim(daemon, secret)).json.status).toBe("pending")
  })

  it("refuses a form bigger than 4 KiB", async () => {
    const daemon = await startDaemon()

    const reply = await decide(daemon, { attempt: "x".repeat(5000), decision: "allow" })

    expect(reply.status).toBe(413)
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large" })
  })

  it("can't be turned into an approval once the user canceled, and doesn't start a sign-in either", async () => {
    const daemon = await startDaemon()
    const { secret, attemptId } = await awaitingConsent(daemon)
    await decide(daemon, { attempt: attemptId, decision: "deny" })

    const late = await decide(daemon, { attempt: attemptId, decision: "allow" })

    expect(late.status).toBe(200)
    expect(header(late, "location")).toBe("")
    expect(late.body).toContain("<h1>Connection canceled</h1>")
    expect(daemon.stub.requests).toEqual([])
    expect((await claim(daemon, secret)).json.status).toBe("denied")
  })
})

describe("pairing while signed in to Prismic", () => {
  it("hands the token over once the user allowed, for that browser only", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, challenge } = newSecret()
    const consent = await openConnect(daemon, { origin: editorOrigin, challenge })
    expect((await claim(daemon, secret)).json).toEqual({ status: "pending" })

    const decision = await decide(daemon, { attempt: attemptIdOf(consent), decision: "allow" })
    const approved = await claim(daemon, secret)

    expect(decision.status).toBe(200)
    expect(decision.body).toContain("<h1>Connected</h1>")
    expect(approved.json.status).toBe("approved")
    const token = approved.json.token ?? ""
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(token).not.toBe(secret)
    expect(token).not.toBe(challenge)

    const authorization = { Authorization: `Bearer ${token}` }
    const status = await send(daemon, "GET", "/status", { headers: { ...authorization, Origin: editorOrigin } })
    expect(status.status).toBe(200)
    expect(prismicOf(status)).toEqual({ status: "signed_in", userId: "user-1" })
    const otherOrigin = await send(daemon, "GET", "/status", { headers: { ...authorization, Origin: deployedOrigin } })
    expect(otherOrigin.status).toBe(401)
    const noOrigin = await send(daemon, "GET", "/status", { headers: authorization })
    expect(noOrigin.status).toBe(401)
  })

  it("pairs a deployed editor to its own origin and the MCP it asked for", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const { secret, challenge } = newSecret()
    const consent = await openConnect(daemon, { origin: deployedOrigin, challenge })
    await decide(daemon, { attempt: attemptIdOf(consent), decision: "allow" })

    const approved = await claim(daemon, secret, deployedOrigin)

    const headers = { Authorization: `Bearer ${approved.json.token ?? ""}` }
    expect((await send(daemon, "GET", "/status", { headers: { ...headers, Origin: deployedOrigin } })).status).toBe(200)
    expect((await send(daemon, "GET", "/status", { headers: { ...headers, Origin: editorOrigin } })).status).toBe(401)
  })

  it("gives the token once: the same secret claimed again is expired", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const attempt = newSecret()
    await allow(daemon, attempt)
    expect((await claim(daemon, attempt.secret)).json.status).toBe("approved")

    const again = await claim(daemon, attempt.secret)

    expect(again.json).toEqual({ status: "expired" })
  })

  it("answers `denied` to a canceled attempt, then `expired`", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    const consent = await openConnect(daemon, { origin: editorOrigin, challenge })

    const canceled = await decide(daemon, { attempt: attemptIdOf(consent), decision: "deny" })
    const first = await claim(daemon, secret)
    const second = await claim(daemon, secret)

    expect(canceled.body).toContain("<h1>Connection canceled</h1>")
    expect(first.json).toEqual({ status: "denied" })
    expect(second.json).toEqual({ status: "expired" })
    expect(daemon.stub.requests).toEqual([])
  })
})

describe("pairing while signed out of Prismic", () => {
  it("sends the popup to the MCP's authorize endpoint, and approves once the callback has signed in", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()

    const decision = await allow(daemon, { challenge })

    expect(decision.status).toBe(302)
    const authorizeUrl = new URL(header(decision, "location"))
    expect(authorizeUrl.origin).toBe(daemon.stub.origin)
    expect(authorizeUrl.pathname).toBe("/authorize")
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${daemon.port}/oauth/prismic/callback`)
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(header(decision, "cache-control")).toBe("no-store")
    expect((await claim(daemon, secret)).json).toEqual({ status: "pending" })

    const { callbackPath } = await authorizeAt(authorizeUrl.href)
    const callback = await send(daemon, "GET", callbackPath)

    expect(callback.status).toBe(200)
    expect(callback.body).toContain("<h1>Connected</h1>")
    const approved = await claim(daemon, secret)
    expect(approved.json.status).toBe("approved")
    const status = await send(daemon, "GET", "/status", {
      headers: { Authorization: `Bearer ${approved.json.token ?? ""}`, Origin: editorOrigin },
    })
    expect(prismicOf(status)).toEqual({ status: "signed_in", userId: "user-1" })
  })

  it("accepts a callback once: replaying it is an expired request", async () => {
    const daemon = await startDaemon()
    const decision = await allow(daemon, newSecret())
    const { callbackPath } = await authorizeAt(header(decision, "location"))
    await send(daemon, "GET", callbackPath)

    const replay = await send(daemon, "GET", callbackPath)

    expect(replay.status).toBe(400)
    expect(replay.body).toContain("This request has expired.")
  })

  it("denies the attempt when the token exchange fails", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    const decision = await allow(daemon, { challenge })
    const { callbackPath } = await authorizeAt(header(decision, "location"))
    daemon.stub.tokenBehavior = "invalid_grant"

    const callback = await send(daemon, "GET", callbackPath)

    expect(callback.body).toContain("<h1>Sign-in failed</h1>")
    expect((await claim(daemon, secret)).json).toEqual({ status: "denied" })
    expect(daemon.prismicAuth.status(daemon.stub.origin)).toEqual({ status: "signed_out" })
  })

  it("denies the attempt when the user cancels at the identity provider", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    const decision = await allow(daemon, { challenge })
    const state = new URL(header(decision, "location")).searchParams.get("state") ?? ""

    const callback = await send(daemon, "GET", `/oauth/prismic/callback?error=access_denied&state=${state}`)

    expect(callback.body).toContain("<h1>Sign-in failed</h1>")
    expect((await claim(daemon, secret)).json).toEqual({ status: "denied" })
  })

  it("denies the attempt and says so when the MCP server can't be reached to start the sign-in", async () => {
    const daemon = await startDaemon()
    daemon.stub.foreignEndpoints = true
    const { secret, challenge } = newSecret()

    const decision = await allow(daemon, { challenge })

    expect(decision.status).toBe(502)
    expect(decision.body).toContain("Couldn&#39;t reach Prismic")
    expect((await claim(daemon, secret)).json).toEqual({ status: "denied" })
  })

  it("keeps a callback for an unknown state, or with none, from approving anything", async () => {
    const daemon = await startDaemon()
    const { secret, challenge } = newSecret()
    await allow(daemon, { challenge })

    const unknown = await send(daemon, "GET", "/oauth/prismic/callback?code=code-1&state=unknown")
    const missing = await send(daemon, "GET", "/oauth/prismic/callback?code=code-1")

    expect(unknown.status).toBe(400)
    expect(unknown.body).toContain("This request has expired.")
    expect(missing.status).toBe(400)
    expect((await claim(daemon, secret)).json).toEqual({ status: "pending" })
    expect(daemon.stub.requestsTo("/token")).toEqual([])
  })
})

describe("POST /pair/claim", () => {
  it("refuses a claim from another origin than the one the attempt was opened for, and the right origin can still claim", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const attempt = newSecret()
    await allow(daemon, attempt)

    const other = await claim(daemon, attempt.secret, deployedOrigin)
    const missing = await claim(daemon, attempt.secret, null)

    expect(other.status).toBe(403)
    expect(other.json).toEqual({ error: "forbidden_origin" })
    expect(missing.status).toBe(403)
    expect(missing.json).toEqual({ error: "forbidden_origin" })
    expect((await claim(daemon, attempt.secret)).json.status).toBe("approved")
  })

  it("doesn't hand a token to a page that only knows the challenge from the popup's URL", async () => {
    const daemon = await startDaemon()
    await signIn(daemon)
    const attempt = newSecret()
    await allow(daemon, attempt)

    const reply = await claim(daemon, attempt.challenge)

    expect(reply.json).toEqual({ status: "expired" })
    expect((await claim(daemon, attempt.secret)).json.status).toBe("approved")
  })

  it("answers `expired` for a secret nobody opened an attempt for", async () => {
    const daemon = await startDaemon()

    const reply = await claim(daemon, newSecret().secret)

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ status: "expired" })
  })

  it.each([
    ["a secret of the wrong length", JSON.stringify({ secret: "abc" })],
    ["a secret that isn't base64url", JSON.stringify({ secret: `${"a".repeat(42)}+` })],
    ["a non-string secret", JSON.stringify({ secret: 1 })],
    ["no secret", JSON.stringify({})],
  ])("answers 400 invalid_request for %s", async (_name, body) => {
    const daemon = await startDaemon()

    const reply = await send(daemon, "POST", "/pair/claim", { headers: { Origin: editorOrigin, "Content-Type": "application/json" }, body })

    expect(reply.status).toBe(400)
    expect(JSON.parse(reply.body)).toEqual({ error: "invalid_request" })
  })

  it("answers 400 invalid_json for a body that isn't JSON, and 413 for a large one", async () => {
    const daemon = await startDaemon()
    const headers = { Origin: editorOrigin, "Content-Type": "application/json" }

    const garbage = await send(daemon, "POST", "/pair/claim", { headers, body: "secret=abc" })
    const large = await send(daemon, "POST", "/pair/claim", { headers, body: JSON.stringify({ secret: "a".repeat(2000) }) })

    expect(garbage.status).toBe(400)
    expect(JSON.parse(garbage.body)).toEqual({ error: "invalid_json" })
    expect(large.status).toBe(413)
  })

  it("refuses an origin that is not an editor's before looking at the body", async () => {
    const daemon = await startDaemon()

    const reply = await claim(daemon, newSecret().secret, "https://evil.com")

    expect(reply.status).toBe(403)
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("lets the Page Builder's origin read the answer: CORS on the claim, and on its preflight", async () => {
    const daemon = await startDaemon()

    const answer = await claim(daemon, newSecret().secret, deployedOrigin)
    const preflight = await send(daemon, "OPTIONS", "/pair/claim", {
      headers: { Origin: deployedOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    })

    expect(answer.headers["access-control-allow-origin"]).toBe(deployedOrigin)
    expect(preflight.status).toBe(204)
    expect(header(preflight, "access-control-allow-origin")).toBe(deployedOrigin)
    expect(header(preflight, "access-control-allow-methods")).toContain("POST")
    expect(header(preflight, "access-control-allow-headers")).toContain("Content-Type")
  })
})
