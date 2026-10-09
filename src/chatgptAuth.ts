import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

import type { ChatGptStatus } from "./protocol.ts"

const issuer = "https://auth.openai.com"
const authorizationEndpoint = `${issuer}/api/accounts/authorize`
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`
const jwksEndpoint = `${issuer}/.well-known/jwks.json`
const discoveryEndpoint = `${issuer}/.well-known/openid-configuration`
const resource = "https://api.openai.com/v1"
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const planUsageScope = "chatgpt.tokens.use.direct"
const agentNameHint = "Prismic Local Agent"
const dynamicClientId = "dynamic_agent_client"
const attemptTtlMs = 10 * 60 * 1000
const requestTimeoutMs = 15_000

export type ChatGptAuthErrorCode = "signed_out" | "plan_usage_disabled" | "refresh_failed"

export class ChatGptAuthError extends Error {
  code: ChatGptAuthErrorCode

  constructor(code: ChatGptAuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

interface BuildAuthorizationUrlArgs {
  clientId?: string
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
  idTokenHint?: string
  loginHint?: string
  forceConsent: boolean
}

export function buildAuthorizationUrl(args: BuildAuthorizationUrlArgs): string {
  const { clientId, hostId, redirectUri, state, nonce, codeChallenge, idTokenHint, loginHint, forceConsent } = args
  const url = new URL(authorizationEndpoint)
  const params = url.searchParams
  params.set("response_type", "code")
  params.set("client_id", clientId ?? dynamicClientId)
  params.set("ext_agent_host_id", hostId)
  params.set("redirect_uri", redirectUri)
  params.set("scope", scopes)
  params.set("resource", resource)
  params.set("state", state)
  params.set("nonce", nonce)
  params.set("code_challenge_method", "S256")
  params.set("code_challenge", codeChallenge)
  if (clientId === undefined) {
    params.set("agent_name_hint", agentNameHint)
  } else {
    if (idTokenHint !== undefined) params.set("id_token_hint", idTokenHint)
    if (loginHint !== undefined) params.set("login_hint", loginHint)
  }
  if (forceConsent) params.set("prompt", "consent")
  return url.href
}

interface ClassifyRefreshFailureArgs {
  status: number
  errorCode: string | undefined
}

export function classifyRefreshFailure(args: ClassifyRefreshFailureArgs): "terminal" | "invalid_client" | "transient" {
  switch (args.errorCode) {
    case "invalid_grant":
    case "invalid_refresh_token":
    case "token_expired":
    case "refresh_token_expired":
    case "refresh_token_invalidated":
    case "refresh_token_reused":
      return "terminal"
    case "invalid_client":
      return "invalid_client"
    default:
      return "transient"
  }
}

const CredentialsSchema = z.object({
  email: z.string().optional(),
  subject: z.string(),
  clientId: z.string(),
  idToken: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()),
  savedAt: z.number(),
})

type Credentials = z.infer<typeof CredentialsSchema>

const HostSchema = z.object({ extAgentHostId: z.string().min(1) })

const TokenResponseSchema = z.object({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
})

type TokenResponse = z.infer<typeof TokenResponseSchema>

const ModelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      slug: z.string().optional(),
      visibility: z.string().optional(),
    }),
  ),
})

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

    console.info(`Sign in with ChatGPT: ${authorizationUrl}`)
    openBrowser(authorizationUrl)
    return authorizationUrl
  }

  async function handleCallback(url: URL): Promise<CallbackResult> {
    const pending = currentAttempt()
    if (pending === undefined) return fail("No ChatGPT sign-in is in progress. Start again from Prismic.")
    if (url.searchParams.get("state") !== pending.state) return { ok: false, message: "Invalid sign-in state." }
    attempt = undefined

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
      await saveSignedInCredentials({ clientId, tokens, pending })
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
  }): Promise<void> {
    const { clientId, tokens, pending } = saveArgs
    if (tokens.id_token === undefined) throw new Error("no ID token in the token response")

    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer, audience: clientId })
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
    refreshing ??= refreshTokens(saved).finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  async function refreshTokens(saved: Credentials): Promise<AccessToken> {
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

    if (!response.ok) {
      const errorCode = await readErrorCode(response)
      console.warn(`ChatGPT token refresh failed: status ${response.status}, error ${errorCode ?? "unknown"}`)
      const failure = classifyRefreshFailure({ status: response.status, errorCode })
      if (failure === "transient") {
        throw new ChatGptAuthError("refresh_failed", `Token refresh failed (${response.status})`)
      }
      clearTokens("The ChatGPT session is no longer valid. Sign in again.")
      throw new ChatGptAuthError("signed_out", "The ChatGPT session is no longer valid")
    }

    const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => undefined))
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

  async function signOut(): Promise<void> {
    attempt = undefined
    const refreshToken = credentials?.refreshToken
    if (credentials !== undefined && refreshToken !== undefined) {
      await revokeRefreshToken({ clientId: credentials.clientId, refreshToken })
    }
    clearTokens(undefined)
  }

  return { getStatus, startSignIn, handleCallback, getAccessToken, signOut }
}

async function revokeRefreshToken(args: { clientId: string; refreshToken: string }): Promise<void> {
  try {
    const discovery = await fetch(discoveryEndpoint, { signal: AbortSignal.timeout(requestTimeoutMs) })
    const metadata = z.object({ revocation_endpoint: z.string().optional() }).parse(await discovery.json())
    if (metadata.revocation_endpoint === undefined) {
      console.warn("ChatGPT sign-out: no revocation endpoint advertised")
      return
    }
    const response = await postForm(metadata.revocation_endpoint, {
      token: args.refreshToken,
      token_type_hint: "refresh_token",
      client_id: args.clientId,
    })
    if (!response.ok) console.warn(`ChatGPT sign-out: token revocation returned ${response.status}`)
  } catch (error) {
    console.warn(`ChatGPT sign-out: token revocation failed: ${errorMessage(error)}`)
  }
}

async function logAvailableModels(accessToken: string | undefined): Promise<void> {
  if (accessToken === undefined) return
  try {
    const response = await fetch(`${resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (!response.ok) {
      console.warn(`Could not list ChatGPT plan models (status ${response.status})`)
      return
    }
    const models = ModelsResponseSchema.parse(await response.json()).data
    const listed = models
      .filter((model) => model.visibility === undefined || model.visibility === "list")
      .map((model) => (model.slug === undefined ? model.id : `${model.id} (${model.slug})`))
    console.info(`Models available on your ChatGPT plan: ${listed.join(", ")}`)
  } catch (error) {
    console.warn(`Could not list ChatGPT plan models: ${errorMessage(error)}`)
  }
}

function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null) return undefined
  const error = (body as { error?: unknown }).error
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

function hasPlanUsageScope(credentials: Credentials | undefined): boolean {
  return credentials?.scopes.includes(planUsageScope) ?? false
}

function loadCredentials(path: string): Credentials | undefined {
  if (!existsSync(path)) return undefined
  try {
    return CredentialsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    console.warn(`Ignoring unreadable ${path}: ${errorMessage(error)}`)
    return undefined
  }
}

function loadHostId(dataDir: string): string {
  const path = join(dataDir, "host.json")
  if (existsSync(path)) {
    try {
      return HostSchema.parse(JSON.parse(readFileSync(path, "utf8"))).extAgentHostId
    } catch (error) {
      console.warn(`Regenerating unreadable ${path}: ${errorMessage(error)}`)
    }
  }
  const extAgentHostId = `urn:uuid:${randomUUID()}`
  writeFileSync(path, JSON.stringify({ extAgentHostId }), { mode: 0o600 })
  return extAgentHostId
}

function openBrowser(url: string): void {
  const command = browserCommand(url)
  if (command === undefined) return
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" })
  child.on("error", (error) => console.warn(`Could not open the browser: ${error.message}`))
  child.unref()
}

function browserCommand(url: string): { file: string; args: string[] } | undefined {
  switch (process.platform) {
    case "darwin":
      return { file: "open", args: [url] }
    case "linux":
      return { file: "xdg-open", args: [url] }
    case "win32":
      return { file: "cmd", args: ["/c", "start", '""', url] }
    default:
      return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
