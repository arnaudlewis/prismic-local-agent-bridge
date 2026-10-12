import { describe, expect, it } from "vitest"

import { parseMcpOrigin } from "./mcpOrigins.ts"

describe("parseMcpOrigin", () => {
  it.each([
    ["https://mcp.prismic.io", "https://mcp.prismic.io"],
    ["https://mcp.wroom.io", "https://mcp.wroom.io"],
    ["https://mcp.marketing-tools-wroom.com", "https://mcp.marketing-tools-wroom.com"],
    ["https://mcp.dev-tools-wroom.com", "https://mcp.dev-tools-wroom.com"],
    ["https://mcp.platform-wroom.com", "https://mcp.platform-wroom.com"],
    ["https://mcp.devops-wroom.com", "https://mcp.devops-wroom.com"],
    ["https://pull-2097-mcp.marketing-tools-wroom.com", "https://pull-2097-mcp.marketing-tools-wroom.com"],
    ["http://localhost:3030", "http://localhost:3030"],
    ["http://127.0.0.1:1234", "http://127.0.0.1:1234"],
    // Only the origin is kept: the sign-in goes to the origin whatever path the caller wrote.
    ["http://127.0.0.1:1234/mcp", "http://127.0.0.1:1234"],
    ["https://mcp.prismic.io/mcp?x=1#y", "https://mcp.prismic.io"],
    ["https://MCP.PRISMIC.IO", "https://mcp.prismic.io"],
  ])("accepts %s as %s", (raw, expected) => {
    expect(parseMcpOrigin(raw)).toBe(expected)
  })

  it.each([
    "https://mcp.prismic.io.evil.com",
    "https://evil.com",
    "https://evil.com/https://mcp.prismic.io",
    "https://evil.com?https://mcp.prismic.io",
    "https://mcp.prismic.io@evil.com",
    "https://evil-mcp.prismic.io",
    "https://prismic.io",
    "https://mcp.prismic.io:8443",
    "http://mcp.prismic.io",
    "http://mcp.marketing-tools-wroom.com",
    "https://user:pw@mcp.prismic.io",
    "https://user@mcp.prismic.io",
    "https://evil.com@mcp.prismic.io",
    "https://localhost:3030",
    "https://127.0.0.1:3030",
    "http://localhost.evil.com:3030",
    "http://127.0.0.1.evil.com",
    "https://mcp.staging-wroom.com",
    "https://evil.com.marketing-tools-wroom.com",
    "https://a.b-mcp.marketing-tools-wroom.com",
    "https://pull-2097-mcp.marketing-tools-wroom.com.evil.com",
    "https://pull-2097-mcp.prismic.io",
    "ftp://mcp.prismic.io",
    "javascript:alert(1)",
    "mcp.prismic.io",
    "",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(parseMcpOrigin(raw)).toBeUndefined()
  })
})
