// The OAuth pieces of "Sign in with ChatGPT" that don't touch the disk or the network.

export const issuer = "https://auth.openai.com"
export const authorizationEndpoint = `${issuer}/api/accounts/authorize`
export const tokenEndpoint = `${issuer}/api/accounts/oauth/token`
export const jwksEndpoint = `${issuer}/.well-known/jwks.json`
export const discoveryEndpoint = `${issuer}/.well-known/openid-configuration`
export const resource = "https://api.openai.com/v1"
export const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
export const planUsageScope = "chatgpt.tokens.use.direct"
export const agentNameHint = "Prismic Local Agent"
export const dynamicClientId = "dynamic_agent_client"
export const attemptTtlMs = 10 * 60 * 1000
export const requestTimeoutMs = 15_000

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

export function redactAuthorizationUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl)
  url.searchParams.delete("id_token_hint")
  url.searchParams.delete("login_hint")
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
