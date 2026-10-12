import { describe, expect, it } from "vitest"

import { isAllowedEditorOrigin, repositoryOf } from "./editorOrigins.ts"

const defaultExtraOrigins = ["http://localhost:5173"]

describe("isAllowedEditorOrigin", () => {
  it.each([
    "https://foo.prismic.io",
    "https://my-repo.prismic.io",
    "https://foo.wroom.io",
    "https://my-repo.marketing-tools-wroom.com",
    "https://my-repo.dev-tools-wroom.com",
    "https://my-repo.platform-wroom.com",
    "https://my-repo.devops-wroom.com",
    "https://9lives.prismic.io",
    // The denylist is exact names: neighbors and names inherited by every object are repositories.
    "https://constructor.prismic.io",
    "https://hasownproperty.prismic.io",
    "https://wwww.prismic.io",
    "https://docs2.prismic.io",
  ])("accepts %s", (origin) => {
    expect(isAllowedEditorOrigin(origin, defaultExtraOrigins)).toBe(true)
  })

  it.each([
    "https://www.prismic.io",
    "https://docs.prismic.io",
    "https://mcp.prismic.io",
    "https://mcp.wroom.io",
    "https://api.marketing-tools-wroom.com",
    "https://a.b.prismic.io",
    "https://a.b.marketing-tools-wroom.com",
    "http://foo.prismic.io",
    "https://prismic.io",
    "https://marketing-tools-wroom.com",
    "https://foo.prismic.io:8443",
    "https://foo.prismic.io:443",
    "https://foo.prismic.io/",
    "https://foo.prismic.io.evil.com",
    "https://evil.com/foo.prismic.io",
    "https://foo.prismic.io@evil.com",
    "https://user@foo.prismic.io",
    "https://evilprismic.io",
    "https://-foo.prismic.io",
    "https://foo_bar.prismic.io",
    "https://Foo.prismic.io",
    "https://foo.staging-wroom.com",
    "https://foo.vercel.app",
    "https://evil.com",
    "null",
    "",
    "foo.prismic.io",
  ])("rejects %s", (origin) => {
    expect(isAllowedEditorOrigin(origin, defaultExtraOrigins)).toBe(false)
  })

  it("matches the extra origins exactly", () => {
    expect(isAllowedEditorOrigin("http://localhost:5173", defaultExtraOrigins)).toBe(true)
    expect(isAllowedEditorOrigin("http://localhost:5174", defaultExtraOrigins)).toBe(false)
    expect(isAllowedEditorOrigin("https://localhost:5173", defaultExtraOrigins)).toBe(false)
    expect(isAllowedEditorOrigin("http://localhost:5173/", defaultExtraOrigins)).toBe(false)
    expect(isAllowedEditorOrigin("http://localhost", defaultExtraOrigins)).toBe(false)
    expect(isAllowedEditorOrigin("http://localhost:5173", [])).toBe(false)
    expect(isAllowedEditorOrigin("https://vercel-preview.vercel.app", ["https://vercel-preview.vercel.app"])).toBe(true)
  })

  it("lets an explicit extra origin through even when it looks like a reserved editor origin", () => {
    // --origin is the user's own decision.
    expect(isAllowedEditorOrigin("https://www.prismic.io", ["https://www.prismic.io"])).toBe(true)
  })
})

describe("repositoryOf", () => {
  it.each([
    ["https://foo.prismic.io", "foo"],
    ["https://my-repo.marketing-tools-wroom.com", "my-repo"],
    ["https://my-repo.wroom.io", "my-repo"],
    ["https://constructor.prismic.io", "constructor"],
  ])("returns the repository of %s", (origin, repository) => {
    expect(repositoryOf(origin)).toBe(repository)
  })

  it.each([
    "https://www.prismic.io",
    "https://mcp.prismic.io",
    "https://a.b.prismic.io",
    "http://foo.prismic.io",
    "https://prismic.io",
    "http://localhost:5173",
    "https://evil.com",
  ])("returns nothing for %s", (origin) => {
    expect(repositoryOf(origin)).toBeUndefined()
  })
})
