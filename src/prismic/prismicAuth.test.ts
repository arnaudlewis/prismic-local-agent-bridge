import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { SecretStore } from "../secrets/secretStore.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { startOAuthStub } from "../testing/oauthStub.ts"
import type { OAuthStub } from "../testing/oauthStub.ts"
import { createMcpUpstream } from "./mcpUpstream.ts"
import { OAuthHttpError, createOAuthClient } from "./oauthClient.ts"
import type { OAuthClient } from "./oauthClient.ts"
import { PrismicSignInRequiredError, PrismicUnavailableError, createPrismicAuth } from "./prismicAuth.ts"
import type { PrismicAuth } from "./prismicAuth.ts"

const daemonPort = 7878
const tenMinutes = 10 * 60 * 1000

let stub: OAuthStub
let time: number

beforeEach(async () => {
  stub = await startOAuthStub()
  time = 1_000_000
  // The auth object logs the status of failures; the tests look at what it does, not at what it says.
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stub.close()
})

type Store = SecretStore & { value(): string | undefined }

function newAuth(args: { store?: Store; port?: number; oauth?: OAuthClient } = {}): Promise<PrismicAuth> {
  return createPrismicAuth({
    dataDir: "/nonexistent",
    port: args.port ?? daemonPort,
    now: () => time,
    oauth: args.oauth,
    stores: { store: args.store ?? createMemorySecretStore() },
  })
}

interface Authorization {
  url: URL
  events: string[]
  // What the popup comes back to the daemon with.
  callback: { state: string; code: string }
}

// What the user's browser does: follows the authorize URL, which answers with the redirect back to the daemon.
async function startSignIn(auth: PrismicAuth): Promise<Authorization> {
  const events: string[] = []
  const url = new URL(
    await auth.beginSignIn({
      mcpOrigin: stub.origin,
      onSignedIn: () => events.push("signed_in"),
      onFailed: (reason) => events.push(`failed:${reason}`),
    }),
  )
  const redirect = await fetch(url, { redirect: "manual" })
  const location = new URL(redirect.headers.get("location") ?? "")
  return { url, events, callback: { state: location.searchParams.get("state") ?? "", code: location.searchParams.get("code") ?? "" } }
}

async function signIn(auth: PrismicAuth): Promise<Authorization> {
  const authorization = await startSignIn(auth)
  expect(await auth.handleCallback(authorization.callback)).toBe("signed_in")
  return authorization
}

function refreshGrants(): number {
  return stub.requestsTo("/token").filter((request) => new URLSearchParams(request.body).get("grant_type") === "refresh_token").length
}

const StoredBlobSchema = z.object({ servers: z.record(z.string(), z.record(z.string(), z.unknown())) })

function storedServer(store: Store): Record<string, unknown> | undefined {
  const raw = store.value()
  if (raw === undefined) return undefined
  return StoredBlobSchema.parse(JSON.parse(raw)).servers[stub.origin]
}

function storedRefreshToken(store: Store): string {
  return z.string().parse(storedServer(store)?.refreshToken)
}

describe("signing in", () => {
  it("completes an authorization-code flow with PKCE and stores who signed in", async () => {
    const auth = await newAuth()
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })

    const { url, events } = await signIn(auth)

    // The stub only issues tokens when the verifier sent at /token hashes to the challenge of the authorize URL.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${daemonPort}/oauth/prismic/callback`)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    expect(events).toEqual(["signed_in"])
    await expect(auth.accessToken(stub.origin)).resolves.toMatch(/^access-/)
  })

  it("never asks for a scope and registers a public client", async () => {
    const auth = await newAuth()
    const { url } = await signIn(auth)

    expect(url.searchParams.has("scope")).toBe(false)
    for (const request of stub.requestsTo("/token")) expect(new URLSearchParams(request.body).has("scope")).toBe(false)
    const registration = z.record(z.string(), z.unknown()).parse(JSON.parse(stub.requestsTo("/register")[0]?.body ?? "{}"))
    expect(registration).not.toHaveProperty("scope")
    expect(registration.token_endpoint_auth_method).toBe("none")
    expect(registration.redirect_uris).toEqual([`http://127.0.0.1:${daemonPort}/oauth/prismic/callback`])
  })

  it("registers once per server and again when the daemon's port, hence the redirect URI, changed", async () => {
    const store = createMemorySecretStore()
    await signIn(await newAuth({ store }))
    await signIn(await newAuth({ store }))
    expect(stub.requestsTo("/register")).toHaveLength(1)

    const moved = await newAuth({ store, port: daemonPort + 1 })
    const { url } = await signIn(moved)
    expect(stub.requestsTo("/register")).toHaveLength(2)
    expect(url.searchParams.get("client_id")).toBe("client-2")
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${daemonPort + 1}/oauth/prismic/callback`)
  })

  it("accepts a callback state once", async () => {
    const auth = await newAuth()
    const { callback, events } = await signIn(auth)

    expect(await auth.handleCallback(callback)).toBe("unknown_state")
    expect(events).toEqual(["signed_in"])
    expect(stub.requestsTo("/token")).toHaveLength(1)
  })

  it("rejects a state it never issued, without calling the server", async () => {
    const auth = await newAuth()
    expect(await auth.handleCallback({ state: "made-up", code: "code-1" })).toBe("unknown_state")
    expect(stub.requestsTo("/token")).toHaveLength(0)
  })

  it("rejects a state after ten minutes", async () => {
    const auth = await newAuth()
    const { callback, events } = await startSignIn(auth)

    time += tenMinutes + 1
    expect(await auth.handleCallback(callback)).toBe("unknown_state")
    expect(events).toEqual([])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
  })

  it("keeps the 16 most recent authorizations", async () => {
    const auth = await newAuth()
    const first = await startSignIn(auth)
    for (let attempt = 0; attempt < 16; attempt += 1) await startSignIn(auth)

    expect(await auth.handleCallback(first.callback)).toBe("unknown_state")
  })

  it("reports a canceled sign-in without exchanging anything", async () => {
    const auth = await newAuth()
    const { callback, events } = await startSignIn(auth)

    expect(await auth.handleCallback({ state: callback.state, error: "access_denied" })).toBe("failed")
    expect(events).toEqual(["failed:canceled"])
    expect(stub.requestsTo("/token")).toHaveLength(0)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
  })

  it("is not signed in when the server refuses the code, and the code can't be tried again", async () => {
    const auth = await newAuth()
    const { callback, events } = await startSignIn(auth)

    stub.tokenBehavior = "invalid_grant"
    expect(await auth.handleCallback(callback)).toBe("failed")
    expect(events).toEqual(["failed:failed"])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })

    stub.tokenBehavior = "success"
    expect(await auth.handleCallback(callback)).toBe("unknown_state")
  })

  it("is not signed in when the user can't be identified, and stores no token", async () => {
    const oauth: OAuthClient = { ...createOAuthClient(), whoami: () => Promise.reject(new OAuthHttpError(401, undefined)) }
    const store = createMemorySecretStore()
    const auth = await newAuth({ oauth, store })
    const { callback, events } = await startSignIn(auth)

    expect(await auth.handleCallback(callback)).toBe("failed")
    expect(events).toEqual(["failed:failed"])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(auth.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(storedServer(store)?.accessToken).toBeUndefined()
    expect(storedServer(store)?.refreshToken).toBeUndefined()
  })

  it("registers again after the server says it doesn't know the client", async () => {
    const auth = await newAuth()
    const { callback } = await startSignIn(auth)
    stub.tokenBehavior = "invalid_client"
    expect(await auth.handleCallback(callback)).toBe("failed")

    stub.tokenBehavior = "success"
    await signIn(auth)
    expect(stub.requestsTo("/register")).toHaveLength(2)
  })

  it("refuses an authorization server whose endpoints are on another origin", async () => {
    stub.foreignEndpoints = true
    const auth = await newAuth()

    await expect(auth.beginSignIn({ mcpOrigin: stub.origin, onSignedIn: () => {}, onFailed: () => {} })).rejects.toBeInstanceOf(
      PrismicUnavailableError,
    )
    expect(stub.requestsTo("/register")).toHaveLength(0)
  })
})

describe("the stored sign-in", () => {
  it("survives a restart, and a sign-out is just as durable", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const token = await auth.accessToken(stub.origin)

    const restarted = await newAuth({ store })
    expect(restarted.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    await expect(restarted.accessToken(stub.origin)).resolves.toBe(token)

    await restarted.signOut(stub.origin)
    const afterSignOut = await newAuth({ store })
    expect(afterSignOut.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(afterSignOut.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
  })

  it.each([["not json"], ['{"version":2,"servers":{}}'], ['{"version":1,"servers":{"x":{"accessToken":42}}}']])(
    "starts signed out, and recovers by signing in, when the stored value is unusable (%s)",
    async (stored) => {
      const store = createMemorySecretStore(stored)
      const auth = await newAuth({ store })
      expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })

      await signIn(auth)
      expect((await newAuth({ store })).status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    },
  )

  it("lists every token it has held for redaction, replaced ones included", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const firstAccess = await auth.accessToken(stub.origin)
    const firstRefresh = storedRefreshToken(store)

    const secondAccess = await auth.refreshAfterUnauthorized(stub.origin, firstAccess)
    const secondRefresh = storedRefreshToken(store)

    expect(new Set([firstAccess, firstRefresh, secondAccess, secondRefresh]).size).toBe(4)
    expect(auth.knownTokens()).toEqual(expect.arrayContaining([firstAccess, firstRefresh, secondAccess, secondRefresh]))

    const restarted = await newAuth({ store })
    expect(restarted.knownTokens()).toEqual(expect.arrayContaining([secondAccess, secondRefresh]))
  })
})

describe("access token", () => {
  it("is refreshed ahead of its expiry, within a minute of it", async () => {
    stub.expiresIn = 3600
    const auth = await newAuth()
    await signIn(auth)
    const first = await auth.accessToken(stub.origin)

    time += (3600 - 61) * 1000
    await expect(auth.accessToken(stub.origin)).resolves.toBe(first)
    expect(refreshGrants()).toBe(0)

    time += 2000
    const second = await auth.accessToken(stub.origin)
    expect(second).not.toBe(first)
    expect(refreshGrants()).toBe(1)
    // The user is already known: refreshing doesn't ask who it is again.
    expect(stub.requestsTo("/whoami")).toHaveLength(1)
  })

  it("is kept until the server refuses it when the server gave no lifetime", async () => {
    stub.expiresIn = undefined
    const auth = await newAuth()
    await signIn(auth)
    const first = await auth.accessToken(stub.origin)

    time += 365 * 24 * 60 * 60 * 1000
    await expect(auth.accessToken(stub.origin)).resolves.toBe(first)
    expect(refreshGrants()).toBe(0)
  })
})

describe("refreshAfterUnauthorized", () => {
  it("makes one token request for concurrent callers", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const rejected = await auth.accessToken(stub.origin)

    stub.tokenDelayMs = 50
    const refreshed = await Promise.all([
      auth.refreshAfterUnauthorized(stub.origin, rejected),
      auth.refreshAfterUnauthorized(stub.origin, rejected),
      auth.refreshAfterUnauthorized(stub.origin, rejected),
    ])

    expect(refreshGrants()).toBe(1)
    expect(new Set(refreshed).size).toBe(1)
    expect(refreshed[0]).not.toBe(rejected)
  })

  it("returns the stored token without a request when it is not the one that was rejected", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const current = await auth.accessToken(stub.origin)
    const requestsBefore = stub.requests.length

    await expect(auth.refreshAfterUnauthorized(stub.origin, "an-older-token")).resolves.toBe(current)
    expect(stub.requests).toHaveLength(requestsBefore)
  })

  it("signs out when the refresh token is refused, but keeps the client registration", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const rejected = await auth.accessToken(stub.origin)

    stub.tokenBehavior = "invalid_grant"
    await expect(auth.refreshAfterUnauthorized(stub.origin, rejected)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(auth.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(storedServer(store)).toMatchObject({ clientId: "client-1" })
    expect(storedServer(store)?.accessToken).toBeUndefined()
    expect(storedServer(store)?.refreshToken).toBeUndefined()

    stub.tokenBehavior = "success"
    await signIn(auth)
    expect(stub.requestsTo("/register")).toHaveLength(1)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
  })

  it("forgets the client registration too when the client is refused", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const rejected = await auth.accessToken(stub.origin)

    stub.tokenBehavior = "invalid_client"
    await expect(auth.refreshAfterUnauthorized(stub.origin, rejected)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    expect(storedServer(store)?.clientId).toBeUndefined()

    stub.tokenBehavior = "success"
    await signIn(auth)
    expect(stub.requestsTo("/register")).toHaveLength(2)
  })

  it("stays signed in when the server fails, so the next call can try again", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const rejected = await auth.accessToken(stub.origin)

    stub.tokenBehavior = "server_error"
    await expect(auth.refreshAfterUnauthorized(stub.origin, rejected)).rejects.toBeInstanceOf(PrismicUnavailableError)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })

    stub.tokenBehavior = "success"
    await expect(auth.refreshAfterUnauthorized(stub.origin, rejected)).resolves.toMatch(/^access-/)
  })

  it("is signed out when there is nothing to refresh", async () => {
    const auth = await newAuth()
    await expect(auth.refreshAfterUnauthorized(stub.origin, "whatever")).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(stub.requests).toHaveLength(0)
  })
})

describe("signOut", () => {
  it("revokes the refresh token at the server and drops the tokens", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const refreshToken = storedRefreshToken(store)

    await auth.signOut(stub.origin)

    expect(stub.requestsTo("/revoke").map((request) => new URLSearchParams(request.body).get("token"))).toEqual([refreshToken])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(auth.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(storedServer(store)).toMatchObject({ clientId: "client-1" })
    expect(storedServer(store)?.refreshToken).toBeUndefined()
  })

  it("signs out of every environment at once, revoking its refresh token", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const refreshToken = storedRefreshToken(store)
    expect(auth.signedInUsers()).toHaveLength(1)

    await auth.signOutEverywhere()

    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    expect(auth.signedInUsers()).toEqual([])
    expect(stub.requestsTo("/revoke").map((request) => new URLSearchParams(request.body).get("token"))).toEqual([refreshToken])
  })

  it("is complete even when the server can't be reached to revoke", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    await signIn(auth)
    const origin = stub.origin
    await stub.close()

    await auth.signOut(origin)
    expect(auth.status(origin)).toEqual({ status: "signed_out" })
    expect(storedServer(store)?.refreshToken).toBeUndefined()
  })

  it("wins over a refresh that is still in flight: the tokens it brings are not stored", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "refresh" })
    const store = createMemorySecretStore()
    const auth = await newAuth({ store, oauth })
    await signIn(auth)
    const rejected = await auth.accessToken(stub.origin)

    const refreshing = auth.refreshAfterUnauthorized(stub.origin, rejected).then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(held()).toBe(1))
    await auth.signOut(stub.origin)
    release()

    expect(await refreshing).toBeInstanceOf(PrismicSignInRequiredError)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(auth.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(storedServer(store)?.accessToken).toBeUndefined()
    expect(storedServer(store)?.refreshToken).toBeUndefined()
  })
})

// A client whose answers reach the daemon only when the test lets them: the server has answered, the answer is on the way.
function holdingOAuth(args: { hold: "register" | "exchangeCode" | "refresh"; times?: number }): { oauth: OAuthClient; release(): void; held(): number } {
  const real = createOAuthClient()
  let remaining = args.times ?? 1
  let held = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  async function hold<T>(call: () => Promise<T>): Promise<T> {
    const result = await call()
    if (remaining <= 0) return result
    remaining -= 1
    held += 1
    await gate
    return result
  }
  const oauth: OAuthClient = {
    ...real,
    register: (callArgs) => (args.hold === "register" ? hold(() => real.register(callArgs)) : real.register(callArgs)),
    exchangeCode: (callArgs) => (args.hold === "exchangeCode" ? hold(() => real.exchangeCode(callArgs)) : real.exchangeCode(callArgs)),
    refresh: (callArgs) => (args.hold === "refresh" ? hold(() => real.refresh(callArgs)) : real.refresh(callArgs)),
  }
  return { oauth, release: () => release(), held: () => held }
}

describe("a sign-out voids what was started before it", () => {
  it("refuses the callback of an authorization begun before the sign-out", async () => {
    const store = createMemorySecretStore()
    const auth = await newAuth({ store })
    const { callback, events } = await startSignIn(auth)

    await auth.signOut(stub.origin)

    // Whoever waits for the sign-in (the connect popup) is told it is over, once.
    expect(events).toEqual(["failed:canceled"])
    // The user gets back from the sign-in page: no tokens are issued for it, and nobody is told twice.
    expect(await auth.handleCallback(callback)).toBe("unknown_state")
    expect(events).toEqual(["failed:canceled"])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    expect(stub.requestsTo("/token")).toHaveLength(0)
    expect(storedServer(store)?.accessToken).toBeUndefined()
  })

  it("does not sign in a code that was being exchanged during the sign-out, and reports the failure", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "exchangeCode" })
    const store = createMemorySecretStore()
    const auth = await newAuth({ store, oauth })
    const { callback, events } = await startSignIn(auth)

    const callbackResult = auth.handleCallback(callback)
    await vi.waitFor(() => expect(held()).toBe(1))
    await auth.signOut(stub.origin)
    release()

    expect(await callbackResult).toBe("failed")
    expect(events).toEqual(["failed:failed"])
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    await expect(auth.accessToken(stub.origin)).rejects.toBeInstanceOf(PrismicSignInRequiredError)
    expect(storedServer(store)?.accessToken).toBeUndefined()
  })

  it("rejects a beginSignIn that was still registering the client during the sign-out", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "register" })
    const auth = await newAuth({ oauth })

    const beginning = auth
      .beginSignIn({ mcpOrigin: stub.origin, onSignedIn: () => {}, onFailed: () => {} })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await vi.waitFor(() => expect(held()).toBe(1))
    await auth.signOut(stub.origin)
    release()

    expect(await beginning).toBeInstanceOf(PrismicSignInRequiredError)
  })

  it("also rejects a beginSignIn that was still registering when every environment was signed out", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "register" })
    const auth = await newAuth({ oauth })

    const beginning = auth
      .beginSignIn({ mcpOrigin: stub.origin, onSignedIn: () => {}, onFailed: () => {} })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    await vi.waitFor(() => expect(held()).toBe(1))
    await auth.signOutEverywhere()
    release()

    expect(await beginning).toBeInstanceOf(PrismicSignInRequiredError)
  })
})

describe("a refresh belongs to the session that started it", () => {
  it("is not joined by callers of a later session, and its late answer changes nothing", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "refresh" })
    const store = createMemorySecretStore()
    const auth = await newAuth({ store, oauth })
    await signIn(auth)
    const firstSessionToken = await auth.accessToken(stub.origin)

    const oldRefresh = auth.refreshAfterUnauthorized(stub.origin, firstSessionToken).then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(held()).toBe(1))
    await auth.signOut(stub.origin)
    await signIn(auth)
    const secondSessionToken = await auth.accessToken(stub.origin)
    expect(secondSessionToken).not.toBe(firstSessionToken)

    // The old refresh is still waiting; the new session refreshes on its own and is not made to wait for it.
    const newRefresh = await auth.refreshAfterUnauthorized(stub.origin, secondSessionToken)
    expect(refreshGrants()).toBe(2)
    expect(newRefresh).not.toBe(secondSessionToken)

    release()
    expect(await oldRefresh).toBeInstanceOf(PrismicSignInRequiredError)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    await expect(auth.accessToken(stub.origin)).resolves.toBe(newRefresh)
    expect(storedServer(store)?.accessToken).toBe(newRefresh)
  })

  it("is superseded by a sign-in that completes while it is in flight", async () => {
    const { oauth, release, held } = holdingOAuth({ hold: "refresh" })
    const store = createMemorySecretStore()
    const auth = await newAuth({ store, oauth })
    await signIn(auth)
    const firstToken = await auth.accessToken(stub.origin)

    const oldRefresh = auth.refreshAfterUnauthorized(stub.origin, firstToken).then(
      () => undefined,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(held()).toBe(1))
    await signIn(auth)
    const signedInToken = await auth.accessToken(stub.origin)
    expect(signedInToken).not.toBe(firstToken)
    const signedInRefreshToken = storedRefreshToken(store)

    release()
    expect(await oldRefresh).toBeInstanceOf(PrismicSignInRequiredError)

    await expect(auth.accessToken(stub.origin)).resolves.toBe(signedInToken)
    expect(storedServer(store)?.accessToken).toBe(signedInToken)
    expect(storedRefreshToken(store)).toBe(signedInRefreshToken)
  })
})

describe("signOutIfRejected", () => {
  it("signs out when the stored token is the one that was rejected", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const current = await auth.accessToken(stub.origin)

    expect(await auth.signOutIfRejected(stub.origin, current)).toBe(true)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
    expect(stub.requestsTo("/revoke")).toHaveLength(1)
  })

  it("leaves a newer sign-in alone", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const older = await auth.accessToken(stub.origin)
    await signIn(auth)
    const newer = await auth.accessToken(stub.origin)

    expect(await auth.signOutIfRejected(stub.origin, older)).toBe(false)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    await expect(auth.accessToken(stub.origin)).resolves.toBe(newer)
    expect(stub.requestsTo("/revoke")).toHaveLength(0)
  })

  it("does nothing when nobody is signed in", async () => {
    const auth = await newAuth()
    expect(await auth.signOutIfRejected(stub.origin, "whatever")).toBe(false)
  })
})

describe("the upstream helper when the server refuses even a refreshed token", () => {
  // The MCP endpoint refuses every token; the OAuth endpoints work.
  function refuseMcpTokens(onRefused?: (call: number) => Promise<void>): { calls(): number } {
    const realFetch = globalThis.fetch
    let calls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (!String(input instanceof Request ? input.url : input).endsWith("/mcp")) return realFetch(input, init)
      calls += 1
      await onRefused?.(calls)
      return new Response('{"error":"unauthorized"}', { status: 401 })
    })
    return { calls: () => calls }
  }

  function sendToolCall(auth: PrismicAuth): Promise<Response> {
    return createMcpUpstream({ auth }).send({
      mcpOrigin: stub.origin,
      path: "/mcp",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("{}"),
      signal: new AbortController().signal,
    })
  }

  it("signs out, because the account is no longer accepted", async () => {
    const auth = await newAuth()
    await signIn(auth)
    const mcp = refuseMcpTokens()

    await expect(sendToolCall(auth)).rejects.toBeInstanceOf(PrismicSignInRequiredError)

    expect(mcp.calls()).toBe(2)
    expect(refreshGrants()).toBe(1)
    expect(auth.status(stub.origin)).toEqual({ status: "signed_out" })
  })

  it("keeps a sign-in that replaced the refused one in the meantime, and reports the server as unavailable", async () => {
    const auth = await newAuth()
    await signIn(auth)
    // While the retry is in flight, the user signs in again.
    refuseMcpTokens(async (call) => {
      if (call === 2) await signIn(auth)
    })

    await expect(sendToolCall(auth)).rejects.toBeInstanceOf(PrismicUnavailableError)

    expect(auth.status(stub.origin)).toEqual({ status: "signed_in", userId: "user-1" })
    await expect(auth.accessToken(stub.origin)).resolves.toMatch(/^access-/)
  })
})
