import { describe, expect, it } from "vitest"

import { classifyRefreshFailure } from "./oauthHttp.ts"

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
