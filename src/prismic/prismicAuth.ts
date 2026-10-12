import { randomBytes } from "node:crypto"
import { z } from "zod"

import { classifyRefreshFailure } from "../oauthHttp.ts"
import type { PrismicStatus } from "../protocol.ts"
import { createDefaultSecretStores } from "../secrets/apiKeyVault.ts"
import type { RevocationMarker } from "../secrets/revocationMarker.ts"
import type { SecretStore } from "../secrets/secretStore.ts"
import { OAuthHttpError, createOAuthClient } from "./oauthClient.ts"
import type { OAuthClient, OAuthMetadata, TokenSet } from "./oauthClient.ts"

// The daemon's own sign-in to the Prismic MCP server: one OAuth client registration and one token set per MCP origin.
// Tokens never leave this object except through accessToken() and refreshAfterUnauthorized(), and only the upstream
// helper (mcpUpstream.ts) asks for them. Nothing here logs more than a status code.

// Raised when there is no usable sign-in: the user has to sign in again from the Page Builder.
export class PrismicSignInRequiredError extends Error {
  constructor() {
    super("Sign in to Prismic is required")
  }
}

// Raised when the MCP server could not be reached or failed: the sign-in is kept, the call can be retried later.
export class PrismicUnavailableError extends Error {
  constructor() {
    super("The Prismic MCP server is unavailable")
  }
}

export interface PrismicAuth {
  status(mcpOrigin: string): PrismicStatus
  // Starts an authorization: returns the URL to send the popup to. `onSignedIn` runs after the tokens and the user id
  // are stored, `onFailed` when the user cancels or the exchange fails.
  beginSignIn(args: {
    mcpOrigin: string
    onSignedIn: () => void
    onFailed: (reason: "canceled" | "failed") => void
  }): Promise<string>
  handleCallback(args: { state: string; code?: string; error?: string }): Promise<"signed_in" | "failed" | "unknown_state">
  // A fresh access token; refreshes when it expires within a minute. Throws PrismicSignInRequiredError when none.
  accessToken(mcpOrigin: string): Promise<string>
  // Called after the server answered 401 to `rejectedToken`: refreshes once (single flight across callers), or throws
  // PrismicSignInRequiredError.
  refreshAfterUnauthorized(mcpOrigin: string, rejectedToken: string): Promise<string>
  signOut(mcpOrigin: string): Promise<void>
  // Signs out of every Prismic environment this daemon holds a sign-in for.
  signOutEverywhere(): Promise<void>
  // Signs out only when the stored access token is still `rejectedToken` (the server refused it even after a
  // refresh); resolves false, leaving a newer sign-in alone, otherwise.
  signOutIfRejected(mcpOrigin: string, rejectedToken: string): Promise<boolean>
  // Every access and refresh token this process has held: for redaction only.
  knownTokens(): string[]
}

interface CreatePrismicAuthArgs {
  dataDir: string
  // The port of the daemon: it is in the redirect URI, so a registration made for another port is made again.
  port: number
  now?: () => number
  oauth?: OAuthClient
  // Tests pass memory stores; the daemon uses the keychain, or a private file when there is none.
  stores?: { store: SecretStore; otherStores?: SecretStore[]; revocation?: RevocationMarker }
}

const ServerEntrySchema = z.object({
  clientId: z.string().optional(),
  redirectUri: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  userId: z.string().optional(),
})

const StoredSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), ServerEntrySchema),
})

type ServerEntry = z.infer<typeof ServerEntrySchema>

interface Attempt {
  mcpOrigin: string
  codeVerifier: string
  createdAt: number
  // The sign-outs of the origin when the authorization began: a later sign-out voids it.
  signOutCount: number
  onSignedIn: () => void
  onFailed: (reason: "canceled" | "failed") => void
}

export const prismicSecretName = "prismic-oauth"

const attemptTtlMs = 10 * 60 * 1000
const maxAttempts = 16
const refreshMarginMs = 60_000

export async function createPrismicAuth(args: CreatePrismicAuthArgs): Promise<PrismicAuth> {
  const { port, now = Date.now } = args
  const oauth = args.oauth ?? createOAuthClient()
  const stores =
    args.stores ??
    (await createDefaultSecretStores({ dataDir: args.dataDir, name: prismicSecretName, label: "Prismic sign-in" }))
  const { store, revocation } = stores
  const otherStores = stores.otherStores ?? []
  if ("notice" in stores && typeof stores.notice === "string") console.warn(stores.notice)

  const redirectUri = `http://127.0.0.1:${port}/oauth/prismic/callback`
  const servers = new Map<string, ServerEntry>()
  const attempts = new Map<string, Attempt>()
  const refreshing = new Map<string, { generation: number; promise: Promise<string> }>()
  const registering = new Map<string, Promise<string>>()
  // Bumped by signOut and by every completed sign-in, so a refresh that finishes afterwards can't store tokens again.
  const generations = new Map<string, number>()
  // Bumped by signOut only: an authorization started before it is void.
  const signOutCounts = new Map<string, number>()
  const seenTokens = new Set<string>()
  let queue: Promise<unknown> = Promise.resolve()

  await load()

  async function load(): Promise<void> {
    const raw = await store.get()
    if (raw === undefined) return
    let parsed: z.infer<typeof StoredSchema>
    try {
      parsed = StoredSchema.parse(JSON.parse(raw))
    } catch {
      console.warn("Ignoring the stored Prismic sign-in: it can't be read, so you will have to sign in again")
      return
    }
    for (const [origin, entry] of Object.entries(parsed.servers)) {
      servers.set(origin, entry)
      rememberTokens(entry)
    }
  }

  function rememberTokens(tokens: { accessToken?: string; refreshToken?: string }): void {
    if (tokens.accessToken !== undefined) seenTokens.add(tokens.accessToken)
    if (tokens.refreshToken !== undefined) seenTokens.add(tokens.refreshToken)
  }

  function generation(mcpOrigin: string): number {
    return generations.get(mcpOrigin) ?? 0
  }

  function signOutCount(mcpOrigin: string): number {
    return signOutCounts.get(mcpOrigin) ?? 0
  }

  // Writes the current state, one write at a time: a write never interleaves with another.
  function persist(): Promise<void> {
    const run = async () => {
      const blob = JSON.stringify({ version: 1, servers: Object.fromEntries(servers) })
      revocation?.record()
      await store.set(blob)
      for (const other of otherStores) {
        try {
          await other.delete()
        } catch {
          console.warn(`Could not remove a copy of the Prismic sign-in kept in the ${other.backend} backend`)
        }
      }
    }
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return result
  }

  // For a change that must not fail the caller: the tokens stay usable in memory for this run.
  async function persistOrWarn(): Promise<void> {
    try {
      await persist()
    } catch {
      console.warn("Could not save the Prismic sign-in: it is kept for this run only")
    }
  }

  function update(mcpOrigin: string, patch: { [K in keyof ServerEntry]: ServerEntry[K] | undefined }): void {
    servers.set(mcpOrigin, { ...servers.get(mcpOrigin), ...patch })
  }

  function clearTokens(mcpOrigin: string): void {
    update(mcpOrigin, { accessToken: undefined, refreshToken: undefined, expiresAt: undefined, userId: undefined })
  }

  function hasTokens(entry: ServerEntry | undefined): entry is ServerEntry {
    return entry !== undefined && (entry.accessToken !== undefined || entry.refreshToken !== undefined)
  }

  function storeTokens(mcpOrigin: string, tokens: TokenSet, userId: string | undefined): void {
    const previous = servers.get(mcpOrigin)
    rememberTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
    update(mcpOrigin, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? previous?.refreshToken,
      expiresAt: tokens.expiresIn === undefined ? undefined : now() + tokens.expiresIn * 1000,
      userId: userId ?? previous?.userId,
    })
  }

  async function discover(mcpOrigin: string): Promise<OAuthMetadata> {
    try {
      return await oauth.discover(mcpOrigin)
    } catch {
      console.warn("Could not read the Prismic authorization server metadata")
      throw new PrismicUnavailableError()
    }
  }

  function ensureRegistration(mcpOrigin: string, metadata: OAuthMetadata): Promise<string> {
    const entry = servers.get(mcpOrigin)
    if (entry?.clientId !== undefined && entry.redirectUri === redirectUri) return Promise.resolve(entry.clientId)
    let registration = registering.get(mcpOrigin)
    if (registration === undefined) {
      registration = register(mcpOrigin, metadata).finally(() => registering.delete(mcpOrigin))
      registering.set(mcpOrigin, registration)
    }
    return registration
  }

  async function register(mcpOrigin: string, metadata: OAuthMetadata): Promise<string> {
    let clientId: string
    try {
      clientId = await oauth.register({ metadata, redirectUri })
    } catch (error) {
      console.warn(`Prismic client registration failed${error instanceof OAuthHttpError ? ` (status ${error.status})` : ""}`)
      throw new PrismicUnavailableError()
    }
    update(mcpOrigin, { clientId, redirectUri })
    await persistOrWarn()
    return clientId
  }

  function status(mcpOrigin: string): PrismicStatus {
    const entry = servers.get(mcpOrigin)
    if (!hasTokens(entry) || entry.userId === undefined) return { status: "signed_out" }
    return { status: "signed_in", userId: entry.userId }
  }

  function purgeAttempts(): void {
    for (const [state, attempt] of attempts) {
      if (now() - attempt.createdAt > attemptTtlMs) attempts.delete(state)
    }
  }

  async function beginSignIn(signIn: {
    mcpOrigin: string
    onSignedIn: () => void
    onFailed: (reason: "canceled" | "failed") => void
  }): Promise<string> {
    const { mcpOrigin } = signIn
    const startedSignOuts = signOutCount(mcpOrigin)
    const metadata = await discover(mcpOrigin)
    const clientId = await ensureRegistration(mcpOrigin, metadata)
    // Signed out while the registration was awaited: this authorization would outlive that sign-out.
    if (signOutCount(mcpOrigin) !== startedSignOuts) throw new PrismicSignInRequiredError()
    const state = randomBytes(32).toString("base64url")
    const codeVerifier = randomBytes(32).toString("base64url")
    purgeAttempts()
    while (attempts.size >= maxAttempts) {
      const oldest = attempts.keys().next().value
      if (oldest === undefined) break
      attempts.delete(oldest)
    }
    attempts.set(state, {
      mcpOrigin,
      codeVerifier,
      createdAt: now(),
      signOutCount: startedSignOuts,
      onSignedIn: signIn.onSignedIn,
      onFailed: signIn.onFailed,
    })
    return oauth.buildAuthorizeUrl({ mcpOrigin, metadata, clientId, redirectUri, state, codeVerifier })
  }

  async function handleCallback(callback: {
    state: string
    code?: string
    error?: string
  }): Promise<"signed_in" | "failed" | "unknown_state"> {
    purgeAttempts()
    const attempt = attempts.get(callback.state)
    if (attempt === undefined) return "unknown_state"
    // Before the token request: an authorization code is only ever tried once.
    attempts.delete(callback.state)
    if (callback.error !== undefined) {
      attempt.onFailed("canceled")
      return "failed"
    }
    if (callback.code === undefined) {
      attempt.onFailed("failed")
      return "failed"
    }
    if (await completeSignIn(attempt, callback.code)) {
      attempt.onSignedIn()
      return "signed_in"
    }
    attempt.onFailed("failed")
    return "failed"
  }

  async function completeSignIn(attempt: Attempt, code: string): Promise<boolean> {
    const { mcpOrigin } = attempt
    // The authorization was started before a sign-out: it no longer counts.
    const isRevoked = () => signOutCount(mcpOrigin) !== attempt.signOutCount
    if (isRevoked()) return false
    const clientId = servers.get(mcpOrigin)?.clientId
    if (clientId === undefined) return false
    try {
      const metadata = await oauth.discover(mcpOrigin)
      const tokens = await oauth.exchangeCode({
        metadata,
        clientId,
        redirectUri,
        code,
        codeVerifier: attempt.codeVerifier,
      })
      rememberTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken })
      const userId = await oauth.whoami({ mcpOrigin, accessToken: tokens.accessToken })
      if (isRevoked()) return false
      storeTokens(mcpOrigin, tokens, userId)
      update(mcpOrigin, { userId })
      // A refresh that started on the previous tokens must not overwrite these when it finishes.
      generations.set(mcpOrigin, generation(mcpOrigin) + 1)
      await persistOrWarn()
      return true
    } catch (error) {
      if (error instanceof OAuthHttpError) {
        console.warn(`Prismic sign-in failed: status ${error.status}, error ${error.errorCode ?? "unknown"}`)
        // The server doesn't know this client (any more): register again on the next attempt.
        if (error.errorCode === "invalid_client") {
          update(mcpOrigin, { clientId: undefined, redirectUri: undefined })
          await persistOrWarn()
        }
      } else {
        console.warn("Prismic sign-in failed: the MCP server could not be reached")
      }
      return false
    }
  }

  async function accessToken(mcpOrigin: string): Promise<string> {
    const entry = servers.get(mcpOrigin)
    if (!hasTokens(entry)) throw new PrismicSignInRequiredError()
    if (entry.accessToken !== undefined && (entry.expiresAt === undefined || entry.expiresAt - now() > refreshMarginMs)) {
      return entry.accessToken
    }
    return refreshOnce(mcpOrigin)
  }

  function refreshAfterUnauthorized(mcpOrigin: string, rejectedToken: string): Promise<string> {
    const entry = servers.get(mcpOrigin)
    if (!hasTokens(entry)) return Promise.reject(new PrismicSignInRequiredError())
    // Another caller already replaced the token that was rejected.
    if (entry.accessToken !== undefined && entry.accessToken !== rejectedToken) return Promise.resolve(entry.accessToken)
    return refreshOnce(mcpOrigin)
  }

  function refreshOnce(mcpOrigin: string): Promise<string> {
    const startedGeneration = generation(mcpOrigin)
    const current = refreshing.get(mcpOrigin)
    // A refresh of a session that was ended since (sign-out, new sign-in) can't serve callers of the current one.
    if (current !== undefined && current.generation === startedGeneration) return current.promise
    const promise = refreshTokens(mcpOrigin, startedGeneration).finally(() => {
      if (refreshing.get(mcpOrigin)?.promise === promise) refreshing.delete(mcpOrigin)
    })
    refreshing.set(mcpOrigin, { generation: startedGeneration, promise })
    return promise
  }

  async function refreshTokens(mcpOrigin: string, startedGeneration: number): Promise<string> {
    const entry = servers.get(mcpOrigin)
    const refreshToken = entry?.refreshToken
    const clientId = entry?.clientId
    if (refreshToken === undefined || clientId === undefined) {
      clearTokens(mcpOrigin)
      await persistOrWarn()
      throw new PrismicSignInRequiredError()
    }

    const metadata = await discover(mcpOrigin)
    let tokens: TokenSet
    try {
      tokens = await oauth.refresh({ metadata, clientId, refreshToken })
    } catch (error) {
      if (generation(mcpOrigin) !== startedGeneration) throw new PrismicSignInRequiredError()
      if (!(error instanceof OAuthHttpError)) {
        console.warn("Prismic token refresh failed: the MCP server could not be reached")
        throw new PrismicUnavailableError()
      }
      console.warn(`Prismic token refresh failed: status ${error.status}, error ${error.errorCode ?? "unknown"}`)
      const failure = classifyRefreshFailure({ status: error.status, errorCode: error.errorCode })
      if (failure === "transient") throw new PrismicUnavailableError()
      clearTokens(mcpOrigin)
      // The registration is gone on the server's side too: register again at the next sign-in.
      if (failure === "invalid_client") update(mcpOrigin, { clientId: undefined, redirectUri: undefined })
      await persistOrWarn()
      throw new PrismicSignInRequiredError()
    }
    if (generation(mcpOrigin) !== startedGeneration) throw new PrismicSignInRequiredError()

    let userId = entry?.userId
    if (userId === undefined) {
      try {
        userId = await oauth.whoami({ mcpOrigin, accessToken: tokens.accessToken })
      } catch {
        throw new PrismicUnavailableError()
      }
      if (generation(mcpOrigin) !== startedGeneration) throw new PrismicSignInRequiredError()
    }
    storeTokens(mcpOrigin, tokens, userId)
    await persistOrWarn()
    return tokens.accessToken
  }

  async function signOut(mcpOrigin: string): Promise<void> {
    // Everything started before this point must not sign the daemon back in: authorizations waiting for their callback,
    // and refreshes still in flight.
    signOutCounts.set(mcpOrigin, signOutCount(mcpOrigin) + 1)
    generations.set(mcpOrigin, generation(mcpOrigin) + 1)
    for (const [state, attempt] of attempts) {
      if (attempt.mcpOrigin !== mcpOrigin) continue
      attempts.delete(state)
      // The popup that was waiting for this authorization is told, instead of waiting out its lifetime.
      attempt.onFailed("canceled")
    }
    const entry = servers.get(mcpOrigin)
    const refreshToken = entry?.refreshToken
    const clientId = entry?.clientId
    clearTokens(mcpOrigin)
    await persist()
    if (refreshToken === undefined || clientId === undefined) return
    try {
      await oauth.revoke({ metadata: await oauth.discover(mcpOrigin), clientId, refreshToken })
    } catch {
      console.warn("Prismic sign-out: token revocation failed")
    }
  }

  // For the desktop app, which doesn't know which Prismic environments the paired browsers use.
  async function signOutEverywhere(): Promise<void> {
    for (const mcpOrigin of [...servers.keys()]) await signOut(mcpOrigin)
  }

  // The server refused `rejectedToken` even after a refresh. Only a sign-in that still holds that token is ended: a
  // newer one (another sign-in or refresh finished meanwhile) is left alone.
  async function signOutIfRejected(mcpOrigin: string, rejectedToken: string): Promise<boolean> {
    if (servers.get(mcpOrigin)?.accessToken !== rejectedToken) return false
    await signOut(mcpOrigin)
    return true
  }

  return {
    status,
    beginSignIn,
    handleCallback,
    accessToken,
    refreshAfterUnauthorized,
    signOut,
    signOutEverywhere,
    signOutIfRejected,
    knownTokens: () => [...seenTokens],
  }
}

// --sign-out-prismic: drops the stored sign-in (the tokens and the client registrations) from every backend.
export async function forgetPrismicSignIn(dataDir: string): Promise<void> {
  const { store, otherStores, revocation } = await createDefaultSecretStores({
    dataDir,
    name: prismicSecretName,
    label: "Prismic sign-in",
  })
  revocation?.record()
  await store.delete()
  for (const other of otherStores) await other.delete()
}
