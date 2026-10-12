import { createHash } from "node:crypto"
import { z } from "zod"

import { defaultRequestTimeoutMs, postForm, readErrorCode } from "../oauthHttp.ts"

// The HTTP side of signing in to the Prismic MCP server: discovery, dynamic client registration, the authorization
// code and refresh grants, revocation and /whoami. It keeps no state except the discovery cache. Every request
// refuses redirects (a token must never follow one to another host) and times out.

const maxResponseBytes = 256 * 1024

export interface OAuthMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  revocationEndpoint: string | undefined
}

export interface TokenSet {
  accessToken: string
  refreshToken: string | undefined
  // Seconds, when the server says.
  expiresIn: number | undefined
}

// The server answered, and refused.
export class OAuthHttpError extends Error {
  status: number
  errorCode: string | undefined

  constructor(status: number, errorCode: string | undefined) {
    super(`OAuth request failed with status ${status}${errorCode === undefined ? "" : ` (${errorCode})`}`)
    this.status = status
    this.errorCode = errorCode
  }
}

// The server could not be reached, or sent something that isn't what the protocol says.
export class OAuthNetworkError extends Error {}

const MetadataSchema = z.object({
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  registration_endpoint: z.url(),
  revocation_endpoint: z.url().optional(),
})

const RegistrationSchema = z.object({ client_id: z.string().min(1) })

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
})

const WhoamiSchema = z.object({ userId: z.string().min(1) })

export interface OAuthClient {
  discover(mcpOrigin: string): Promise<OAuthMetadata>
  register(args: { metadata: OAuthMetadata; redirectUri: string }): Promise<string>
  buildAuthorizeUrl(args: {
    mcpOrigin: string
    metadata: OAuthMetadata
    clientId: string
    redirectUri: string
    state: string
    codeVerifier: string
  }): string
  exchangeCode(args: {
    metadata: OAuthMetadata
    clientId: string
    redirectUri: string
    code: string
    codeVerifier: string
  }): Promise<TokenSet>
  refresh(args: { metadata: OAuthMetadata; clientId: string; refreshToken: string }): Promise<TokenSet>
  // Best effort: logs the status of a failure, never anything else.
  revoke(args: { metadata: OAuthMetadata; clientId: string; refreshToken: string }): Promise<void>
  whoami(args: { mcpOrigin: string; accessToken: string }): Promise<string>
}

export function createOAuthClient(args: { timeoutMs?: number } = {}): OAuthClient {
  const timeoutMs = args.timeoutMs ?? defaultRequestTimeoutMs
  const discovered = new Map<string, OAuthMetadata>()

  async function request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      // The cause can name a URL; the class of failure is enough.
      throw new OAuthNetworkError(error instanceof Error ? error.name : "request failed")
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => undefined)
    if (text === undefined || text.length > maxResponseBytes) throw new OAuthNetworkError("unreadable response")
    try {
      return JSON.parse(text)
    } catch {
      throw new OAuthNetworkError("response is not JSON")
    }
  }

  async function parseTokens(response: Response): Promise<TokenSet> {
    if (!response.ok) throw new OAuthHttpError(response.status, await readErrorCode(response))
    const parsed = TokenResponseSchema.safeParse(await readJson(response))
    if (!parsed.success) throw new OAuthNetworkError("unexpected token response")
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresIn: parsed.data.expires_in,
    }
  }

  async function postTokenForm(url: string, fields: Record<string, string>): Promise<Response> {
    try {
      return await postForm(url, fields, { timeoutMs, redirect: "error" })
    } catch (error) {
      throw new OAuthNetworkError(error instanceof Error ? error.name : "request failed")
    }
  }

  return {
    async discover(mcpOrigin) {
      const cached = discovered.get(mcpOrigin)
      if (cached !== undefined) return cached
      const response = await request(`${mcpOrigin}/.well-known/oauth-authorization-server`, {
        headers: { Accept: "application/json" },
      })
      if (!response.ok) throw new OAuthHttpError(response.status, undefined)
      const parsed = MetadataSchema.safeParse(await readJson(response))
      if (!parsed.success) throw new OAuthNetworkError("unexpected authorization server metadata")
      const endpoints = [
        parsed.data.authorization_endpoint,
        parsed.data.token_endpoint,
        parsed.data.registration_endpoint,
        parsed.data.revocation_endpoint,
      ]
      // The tokens are only ever sent to endpoints on the MCP's own origin.
      for (const endpoint of endpoints) {
        if (endpoint !== undefined && new URL(endpoint).origin !== mcpOrigin) {
          throw new OAuthNetworkError("authorization server metadata points to another origin")
        }
      }
      const metadata: OAuthMetadata = {
        authorizationEndpoint: parsed.data.authorization_endpoint,
        tokenEndpoint: parsed.data.token_endpoint,
        registrationEndpoint: parsed.data.registration_endpoint,
        revocationEndpoint: parsed.data.revocation_endpoint,
      }
      discovered.set(mcpOrigin, metadata)
      return metadata
    },

    async register({ metadata, redirectUri }) {
      const response = await request(metadata.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "Prismic local agent",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      })
      if (!response.ok) throw new OAuthHttpError(response.status, await readErrorCode(response))
      const parsed = RegistrationSchema.safeParse(await readJson(response))
      if (!parsed.success) throw new OAuthNetworkError("unexpected registration response")
      return parsed.data.client_id
    },

    buildAuthorizeUrl({ mcpOrigin, metadata, clientId, redirectUri, state, codeVerifier }) {
      const url = new URL(metadata.authorizationEndpoint)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", clientId)
      url.searchParams.set("redirect_uri", redirectUri)
      url.searchParams.set("state", state)
      url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"))
      url.searchParams.set("code_challenge_method", "S256")
      url.searchParams.set("resource", `${mcpOrigin}/mcp`)
      // No scope: the client is registered without one and the server adds offline_access itself.
      return url.href
    },

    async exchangeCode({ metadata, clientId, redirectUri, code, codeVerifier }) {
      return parseTokens(
        await postTokenForm(metadata.tokenEndpoint, {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
      )
    },

    async refresh({ metadata, clientId, refreshToken }) {
      return parseTokens(
        await postTokenForm(metadata.tokenEndpoint, {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }),
      )
    },

    async revoke({ metadata, clientId, refreshToken }) {
      if (metadata.revocationEndpoint === undefined) return
      try {
        const response = await postTokenForm(metadata.revocationEndpoint, {
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: clientId,
        })
        if (!response.ok) console.warn(`Prismic sign-out: token revocation returned ${response.status}`)
      } catch {
        console.warn("Prismic sign-out: token revocation failed")
      }
    },

    async whoami({ mcpOrigin, accessToken }) {
      const response = await request(`${mcpOrigin}/whoami`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      })
      if (!response.ok) throw new OAuthHttpError(response.status, undefined)
      const parsed = WhoamiSchema.safeParse(await readJson(response))
      if (!parsed.success) throw new OAuthNetworkError("unexpected whoami response")
      return parsed.data.userId
    },
  }
}
