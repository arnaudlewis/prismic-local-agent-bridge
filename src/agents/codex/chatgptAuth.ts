import { createHash, randomBytes } from "node:crypto"
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

import { errorMessage } from "../../errors.ts"
import type { ChatGptStatus } from "../../protocol.ts"
import { CredentialsSchema, hasPlanUsageScope, loadCredentials, loadHostId } from "./credentialsFile.ts"
import type { Credentials } from "./credentialsFile.ts"
import {
  attemptTtlMs,
  authorizationEndpoint,
  buildAuthorizationUrl,
  classifyRefreshFailure,
  issuer,
  jwksEndpoint,
  redactAuthorizationUrl,
  resource,
  scopes,
  tokenEndpoint,
} from "./oauth.ts"
import { logAvailableModels, openBrowser, postForm, readErrorCode, revokeRefreshToken } from "./oauthHttp.ts"

export type ChatGptAuthErrorCode = "signed_out" | "plan_usage_disabled" | "refresh_failed"

export class ChatGptAuthError extends Error {
  code: ChatGptAuthErrorCode

  constructor(code: ChatGptAuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const TokenResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
})

type TokenResponse = z.infer<typeof TokenResponseSchema>

interface PendingAttempt {
  state: string
  nonce: string
  verifier: string
  expiresAt: number
  reauthorization: { clientId: string; subject: string } | undefined
}

interface CreateChatGptAuthArgs {
  dataDir: string
  redirectUri: string
}

export interface AccessToken {
  accessToken: string
  expiresAt: number
}

export interface CallbackResult {
  ok: boolean
  message: string
}

export interface ChatGptAuth {
  getStatus(): ChatGptStatus
  startSignIn(): string
  handleCallback(url: URL): Promise<CallbackResult>
  getAccessToken(minValidityMs: number): Promise<AccessToken>
  signOut(): Promise<void>
}


export function createChatGptAuth(args: CreateChatGptAuthArgs): ChatGptAuth {
  const { dataDir, redirectUri } = args
  const credentialsPath = join(dataDir, "credentials.json")

  const jwks = createRemoteJWKSet(new URL(jwksEndpoint))
  let credentials = loadCredentials(credentialsPath)
  let attempt: PendingAttempt | undefined
  let lastError: string | undefined
  let refreshing: Promise<AccessToken> | undefined
  // Bumped by signOut so in-flight sign-ins and refreshes can't write credentials back afterwards.
  let generation = 0

  function currentAttempt(): PendingAttempt | undefined {
    if (attempt !== undefined && attempt.expiresAt < Date.now()) attempt = undefined
    return attempt
  }

  function saveCredentials(next: Credentials): void {
    credentials = next
    const temporaryPath = `${credentialsPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(next, undefined, 2), { mode: 0o600 })
    renameSync(temporaryPath, credentialsPath)
  }

  function clearTokens(error: string | undefined): void {
    lastError = error
    if (credentials === undefined) return
    saveCredentials({
      ...credentials,
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: undefined,
      savedAt: Date.now(),
    })
  }

  function hasTokens(): boolean {
    return credentials?.refreshToken !== undefined || credentials?.accessToken !== undefined
  }

  function getStatus(): ChatGptStatus {
    const planUsage = hasTokens() && hasPlanUsageScope(credentials)
    if (currentAttempt() !== undefined) {
      return { status: "signing_in", planUsage, error: lastError }
    }
    if (!hasTokens()) return { status: "signed_out", planUsage: false, error: lastError }
    return { status: "signed_in", email: credentials?.email, planUsage, error: lastError }
  }

  function startSignIn(): string {
    const state = randomBytes(32).toString("base64url")
    const nonce = randomBytes(32).toString("base64url")
    const verifier = randomBytes(32).toString("base64url")
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url")
    const saved = credentials

    const authorizationUrl = buildAuthorizationUrl({
      clientId: saved?.clientId,
      hostId: loadHostId(dataDir),
      redirectUri,
      state,
      nonce,
      codeChallenge,
      idTokenHint: saved?.idToken,
      loginHint: saved?.email,
      forceConsent: saved !== undefined && !hasPlanUsageScope(saved),
    })

    attempt = {
      state,
      nonce,
      verifier,
      expiresAt: Date.now() + attemptTtlMs,
      reauthorization: saved === undefined ? undefined : { clientId: saved.clientId, subject: saved.subject },
    }
    lastError = undefined

    console.info(`Sign in with ChatGPT: ${redactAuthorizationUrl(authorizationUrl)}`)
    openBrowser(authorizationUrl)
    return authorizationUrl
  }

  async function handleCallback(url: URL): Promise<CallbackResult> {
    const pending = currentAttempt()
    if (pending === undefined) return fail("No ChatGPT sign-in is in progress. Start again from Prismic.")
    if (url.searchParams.get("state") !== pending.state) return { ok: false, message: "Invalid sign-in state." }
    attempt = undefined
    const startedGeneration = generation

    const errorParam = url.searchParams.get("error")
    if (errorParam !== null) {
      const message =
        errorParam === "access_denied" ? "ChatGPT sign-in was cancelled" : `ChatGPT sign-in failed: ${errorParam}`
      return fail(message)
    }
    const code = url.searchParams.get("code")
    if (code === null) return fail("ChatGPT sign-in failed: missing authorization code")

    const clientIdParam = url.searchParams.get("client_id")
    let clientId: string
    if (pending.reauthorization === undefined) {
      if (clientIdParam === null) return fail("ChatGPT sign-in failed: no client registered")
      clientId = clientIdParam
    } else {
      if (clientIdParam !== null && clientIdParam !== pending.reauthorization.clientId) {
        return fail("ChatGPT sign-in failed: unexpected client")
      }
      clientId = pending.reauthorization.clientId
    }

    try {
      const tokens = await exchangeCode({ clientId, code, verifier: pending.verifier })
      if (generation !== startedGeneration) throw new Error("signed out while signing in")
      await saveSignedInCredentials({ clientId, tokens, pending, startedGeneration })
      await logAvailableModels(tokens.access_token)
      return { ok: true, message: "Signed in to ChatGPT. You can close this tab and go back to Prismic." }
    } catch (error) {
      return fail(`ChatGPT sign-in failed: ${errorMessage(error)}`)
    }
  }

  function fail(message: string): CallbackResult {
    lastError = message
    console.warn(message)
    return { ok: false, message }
  }

  async function exchangeCode(exchangeArgs: {
    clientId: string
    code: string
    verifier: string
  }): Promise<TokenResponse> {
    const response = await postForm(tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: exchangeArgs.clientId,
      code: exchangeArgs.code,
      code_verifier: exchangeArgs.verifier,
      redirect_uri: redirectUri,
      resource,
    })
    if (!response.ok) throw new Error(`token endpoint returned ${response.status}`)
    return TokenResponseSchema.parse(await response.json())
  }

  async function saveSignedInCredentials(saveArgs: {
    clientId: string
    tokens: TokenResponse
    pending: PendingAttempt
    startedGeneration: number
  }): Promise<void> {
    const { clientId, tokens, pending, startedGeneration } = saveArgs
    if (tokens.id_token === undefined) throw new Error("no ID token in the token response")

    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer, audience: clientId })
    if (generation !== startedGeneration) throw new Error("signed out while signing in")
    if (payload.nonce !== pending.nonce) throw new Error("ID token nonce mismatch")
    if (payload.sub === undefined) throw new Error("ID token has no subject")
    if (pending.reauthorization !== undefined && payload.sub !== pending.reauthorization.subject) {
      throw new Error("ChatGPT account differs from the one already registered")
    }

    const grantedScopes = (tokens.scope ?? scopes).split(" ").filter(Boolean)
    lastError = undefined
    saveCredentials({
      email: typeof payload.email === "string" ? payload.email : undefined,
      subject: payload.sub,
      clientId,
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
      scopes: grantedScopes,
      savedAt: Date.now(),
    })
  }

  function getAccessToken(minValidityMs: number): Promise<AccessToken> {
    const saved = credentials
    if (saved === undefined || !hasTokens()) {
      return Promise.reject(new ChatGptAuthError("signed_out", "Not signed in to ChatGPT"))
    }
    if (!hasPlanUsageScope(saved)) {
      return Promise.reject(new ChatGptAuthError("plan_usage_disabled", "ChatGPT plan use is not enabled"))
    }
    if (
      saved.accessToken !== undefined &&
      saved.expiresAt !== undefined &&
      saved.expiresAt - Date.now() >= minValidityMs
    ) {
      return Promise.resolve({ accessToken: saved.accessToken, expiresAt: saved.expiresAt })
    }
    refreshing ??= refreshTokens(saved, generation).finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  async function refreshTokens(saved: Credentials, startedGeneration: number): Promise<AccessToken> {
    if (saved.refreshToken === undefined) {
      clearTokens("The ChatGPT session expired. Sign in again.")
      throw new ChatGptAuthError("signed_out", "The ChatGPT session expired")
    }

    let response: Response
    try {
      response = await postForm(tokenEndpoint, {
        grant_type: "refresh_token",
        client_id: saved.clientId,
        refresh_token: saved.refreshToken,
        resource,
      })
    } catch (error) {
      console.warn(`ChatGPT token refresh failed: ${errorMessage(error)}`)
      throw new ChatGptAuthError("refresh_failed", "Could not reach the ChatGPT token endpoint")
    }

    if (generation !== startedGeneration) throw signedOutDuringRefresh()

    if (!response.ok) {
      const errorCode = await readErrorCode(response)
      if (generation !== startedGeneration) throw signedOutDuringRefresh()
      console.warn(`ChatGPT token refresh failed: status ${response.status}, error ${errorCode ?? "unknown"}`)
      const failure = classifyRefreshFailure({ status: response.status, errorCode })
      if (failure === "transient") {
        throw new ChatGptAuthError("refresh_failed", `Token refresh failed (${response.status})`)
      }
      clearTokens("The ChatGPT session is no longer valid. Sign in again.")
      throw new ChatGptAuthError("signed_out", "The ChatGPT session is no longer valid")
    }

    const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (generation !== startedGeneration) throw signedOutDuringRefresh()
    const accessToken = parsed.success ? parsed.data.access_token : undefined
    if (!parsed.success || accessToken === undefined) {
      throw new ChatGptAuthError("refresh_failed", "Unexpected token refresh response")
    }
    const tokens = parsed.data
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
    lastError = undefined
    saveCredentials({
      ...saved,
      accessToken,
      refreshToken: tokens.refresh_token ?? saved.refreshToken,
      expiresAt,
      scopes: tokens.scope === undefined ? saved.scopes : tokens.scope.split(" ").filter(Boolean),
      savedAt: Date.now(),
    })
    return { accessToken, expiresAt }
  }

  function signedOutDuringRefresh(): ChatGptAuthError {
    return new ChatGptAuthError("signed_out", "Signed out while the ChatGPT session was refreshing")
  }

  async function signOut(): Promise<void> {
    generation += 1
    attempt = undefined
    const refreshToken = credentials?.refreshToken
    if (credentials !== undefined && refreshToken !== undefined) {
      await revokeRefreshToken({ clientId: credentials.clientId, refreshToken })
    }
    clearTokens(undefined)
  }

  return { getStatus, startSignIn, handleCallback, getAccessToken, signOut }
}

