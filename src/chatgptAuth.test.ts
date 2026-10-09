import { describe, expect, it } from "vitest"

import { buildAuthorizationUrl, classifyRefreshFailure } from "./chatgptAuth.ts"

const baseArgs = {
  hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  redirectUri: "http://127.0.0.1:7878/auth/callback",
  state: "state-value",
  nonce: "nonce-value",
  codeChallenge: "challenge-value",
  forceConsent: false,
}

describe("buildAuthorizationUrl", () => {
  it("registers a dynamic client on first sign-in", () => {
    const url = new URL(buildAuthorizationUrl(baseArgs))
    const params = url.searchParams

    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize")
    expect(params.get("client_id")).toBe("dynamic_agent_client")
    expect(params.get("agent_name_hint")).toBe("Prismic Local Agent")
    expect(params.get("id_token_hint")).toBeNull()
    expect(params.get("login_hint")).toBeNull()
    expect(params.get("prompt")).toBeNull()
    expect(params.get("ext_agent_host_id")).toBe(baseArgs.hostId)
    expect(params.get("response_type")).toBe("code")
    expect(params.get("redirect_uri")).toBe(baseArgs.redirectUri)
    expect(params.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    )
    expect(params.get("resource")).toBe("https://api.openai.com/v1")
    expect(params.get("state")).toBe("state-value")
    expect(params.get("nonce")).toBe("nonce-value")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("code_challenge")).toBe("challenge-value")
  })

  it("reuses the registered client on reauthorization", () => {
    const params = new URL(
      buildAuthorizationUrl({ ...baseArgs, clientId: "client-1", idTokenHint: "id-token", loginHint: "me@example.com" }),
    ).searchParams

    expect(params.get("client_id")).toBe("client-1")
    expect(params.get("id_token_hint")).toBe("id-token")
    expect(params.get("login_hint")).toBe("me@example.com")
    expect(params.get("agent_name_hint")).toBeNull()
  })

  it("forces consent when asked", () => {
    const params = new URL(buildAuthorizationUrl({ ...baseArgs, forceConsent: true })).searchParams
    expect(params.get("prompt")).toBe("consent")
  })
})

describe("classifyRefreshFailure", () => {
  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("treats %s as terminal", (errorCode) => {
    expect(classifyRefreshFailure({ status: 400, errorCode })).toBe("terminal")
  })

  it("detects invalid_client", () => {
    expect(classifyRefreshFailure({ status: 401, errorCode: "invalid_client" })).toBe("invalid_client")
  })

  it("treats everything else as transient", () => {
    expect(classifyRefreshFailure({ status: 500, errorCode: undefined })).toBe("transient")
    expect(classifyRefreshFailure({ status: 429, errorCode: "rate_limited" })).toBe("transient")
  })
})
