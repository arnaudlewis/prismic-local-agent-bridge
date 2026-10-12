import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createPairing, forgetPairings } from "./pairing.ts"

const day = 24 * 60 * 60 * 1000
const hour = 60 * 60 * 1000

const editorOrigin = "https://foo.prismic.io"
const mcpOrigin = "https://mcp.prismic.io"
const browser = { origin: editorOrigin, mcpOrigin }

function createStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-pairing-"))
  return { dataDir, file: join(dataDir, "pairing.json") }
}

interface StoredFile {
  version: number
  browsers: Array<{ tokenHash: string; origin: string; mcpOrigin: string; createdAt: number; lastUsedAt: number }>
}

function readStored(file: string): StoredFile {
  return JSON.parse(readFileSync(file, "utf8")) as StoredFile
}

describe("createPairing", () => {
  it("returns the browser a token was issued to, with its MCP origin", () => {
    const pairing = createPairing({})
    const token = pairing.issueToken(browser)

    expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
    expect(pairing.pairedBrowserCount()).toBe(1)
  })

  it("only accepts a token from the origin it was issued for", () => {
    const pairing = createPairing({})
    const token = pairing.issueToken(browser)

    expect(pairing.validateToken(token, undefined)).toBeUndefined()
    expect(pairing.validateToken(token, "https://evil.com")).toBeUndefined()
    expect(pairing.validateToken(token, "https://bar.prismic.io")).toBeUndefined()
    expect(pairing.validateToken(token, `${editorOrigin}/`)).toBeUndefined()
    expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
  })

  it("keeps each token bound to its own origin and MCP origin", () => {
    const pairing = createPairing({})
    const other = { origin: "http://localhost:5173", mcpOrigin: "http://127.0.0.1:4000" }
    const first = pairing.issueToken(browser)
    const second = pairing.issueToken(other)

    expect(first).not.toBe(second)
    expect(pairing.validateToken(first, editorOrigin)).toEqual(browser)
    expect(pairing.validateToken(second, other.origin)).toEqual(other)
    expect(pairing.validateToken(first, other.origin)).toBeUndefined()
    expect(pairing.validateToken(second, editorOrigin)).toBeUndefined()
  })

  it("rejects unknown, empty, altered and truncated tokens", () => {
    const { dataDir } = createStore()
    const pairing = createPairing({ dataDir })
    const token = pairing.issueToken(browser)

    expect(pairing.validateToken("unknown", editorOrigin)).toBeUndefined()
    expect(pairing.validateToken("", editorOrigin)).toBeUndefined()
    expect(pairing.validateToken(`${token}x`, editorOrigin)).toBeUndefined()
    expect(pairing.validateToken(token.slice(0, -1), editorOrigin)).toBeUndefined()
    expect(createPairing({ dataDir }).validateToken("unknown", editorOrigin)).toBeUndefined()
  })

  it("keeps the in-memory behavior when there is no data dir", () => {
    const pairing = createPairing({})
    const token = pairing.issueToken(browser)

    expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
    expect(createPairing({}).validateToken(token, editorOrigin)).toBeUndefined()
  })
})

describe("persistent pairing", () => {
  it("keeps a paired browser, with its origins, across a new instance on the same dir", () => {
    const { dataDir } = createStore()
    const token = createPairing({ dataDir }).issueToken(browser)

    const second = createPairing({ dataDir })

    expect(second.validateToken(token, editorOrigin)).toEqual(browser)
    expect(second.validateToken(token, "https://evil.com")).toBeUndefined()
    expect(second.pairedBrowserCount()).toBe(1)
  })

  it("never writes the raw token, and writes the file with mode 0600", () => {
    const { dataDir, file } = createStore()
    const token = createPairing({ dataDir }).issueToken(browser)

    const content = readFileSync(file, "utf8")
    expect(content).not.toContain(token)
    expect(JSON.parse(content)).toEqual({
      version: 2,
      browsers: [
        {
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          origin: editorOrigin,
          mcpOrigin,
          createdAt: expect.any(Number),
          lastUsedAt: expect.any(Number),
        },
      ],
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("expires a token unused for 30 days, at load and on check", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const first = createPairing({ dataDir, now: () => time })
    const token = first.issueToken(browser)

    time += 29 * day
    expect(first.validateToken(token, editorOrigin)).toEqual(browser)
    time += 31 * day
    expect(first.validateToken(token, editorOrigin)).toBeUndefined()
    expect(first.pairedBrowserCount()).toBe(0)

    time = 5_000_000
    const second = createPairing({ dataDir, now: () => time })
    const other = second.issueToken(browser)
    time += 31 * day
    const third = createPairing({ dataDir, now: () => time })
    expect(third.pairedBrowserCount()).toBe(0)
    expect(third.validateToken(other, editorOrigin)).toBeUndefined()
  })

  it("keeps a token alive as long as it is used", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ dataDir, now: () => time })
    const token = pairing.issueToken(browser)

    for (let step = 0; step < 4; step++) {
      time += 20 * day
      expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
    }
  })

  it("does not refresh a token's lifetime when it is presented from the wrong origin", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ dataDir, now: () => time })
    const token = pairing.issueToken(browser)

    time += 20 * day
    expect(pairing.validateToken(token, "https://evil.com")).toBeUndefined()
    time += 20 * day

    expect(pairing.validateToken(token, editorOrigin)).toBeUndefined()
  })

  it("keeps at most 20 paired browsers and drops the least recently used one", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ dataDir, now: () => time })
    const tokens: string[] = []
    for (let index = 0; index < 20; index++) {
      time += 1000
      tokens.push(pairing.issueToken(browser))
    }
    time += 1000
    expect(pairing.validateToken(tokens[0] ?? "", editorOrigin)).toEqual(browser)

    time += 1000
    const newest = pairing.issueToken(browser)

    expect(pairing.pairedBrowserCount()).toBe(20)
    expect(pairing.validateToken(tokens[1] ?? "", editorOrigin)).toBeUndefined()
    expect(pairing.validateToken(tokens[0] ?? "", editorOrigin)).toEqual(browser)
    expect(pairing.validateToken(newest, editorOrigin)).toEqual(browser)
    expect(createPairing({ dataDir, now: () => time }).pairedBrowserCount()).toBe(20)
  })

  const validEntry = { tokenHash: "a".repeat(64), origin: editorOrigin, mcpOrigin, createdAt: 1, lastUsedAt: 1 }

  // Each fixture is valid JSON (except the first) with one specific wrong shape, so zod is what rejects it. The
  // marker sits in a string the schema would reject or ignore, to prove warnings never print file content.
  it.each([
    ["invalid JSON", "{not json SECRET-CONTENT"],
    ["version 1", JSON.stringify({ version: 1, tokens: [{ hash: "a".repeat(64), createdAt: 1, lastUsedAt: 1 }], note: "SECRET-CONTENT" })],
    ["browsers is not an array", JSON.stringify({ version: 2, browsers: "SECRET-CONTENT" })],
    ["a non-hex hash", JSON.stringify({ version: 2, browsers: [{ ...validEntry, tokenHash: "SECRET-CONTENT" }] })],
    ["a short hash", JSON.stringify({ version: 2, browsers: [{ ...validEntry, tokenHash: "abc123" }] })],
    ["a missing origin", JSON.stringify({ version: 2, browsers: [{ ...validEntry, origin: undefined, note: "SECRET-CONTENT" }] })],
    ["a missing mcpOrigin", JSON.stringify({ version: 2, browsers: [{ ...validEntry, mcpOrigin: undefined, note: "SECRET-CONTENT" }] })],
    ["a missing lastUsedAt", JSON.stringify({ version: 2, browsers: [{ ...validEntry, lastUsedAt: undefined, note: "SECRET-CONTENT" }] })],
    ["a string timestamp", JSON.stringify({ version: 2, browsers: [{ ...validEntry, createdAt: "SECRET-CONTENT" }] })],
    ["21 entries", JSON.stringify({ version: 2, browsers: Array.from({ length: 21 }, () => validEntry) })],
    ["a top-level array", JSON.stringify([validEntry, "SECRET-CONTENT"])],
    ["null", "null"],
    ["oversized", JSON.stringify({ version: 2, browsers: [], note: "SECRET-CONTENT".repeat(6000) })],
  ])("ignores a corrupt file (%s) with a warning that does not print its content", (_name, content) => {
    const { dataDir, file } = createStore()
    writeFileSync(file, content)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const pairing = createPairing({ dataDir })

    expect(pairing.pairedBrowserCount()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET-CONTENT")
    warn.mockRestore()
    expect(pairing.issueToken(browser)).toBeTruthy()
  })

  it("accepts a well-formed file, so the corrupt cases above fail for their own reason", () => {
    const { dataDir, file } = createStore()
    writeFileSync(file, JSON.stringify({ version: 2, browsers: [{ ...validEntry, lastUsedAt: Date.now() }] }))

    expect(createPairing({ dataDir }).pairedBrowserCount()).toBe(1)
  })

  it("ignores a version 1 file, so the browser pairs again", () => {
    const { dataDir, file } = createStore()
    writeFileSync(file, JSON.stringify({ version: 1, tokens: [{ hash: "a".repeat(64), createdAt: Date.now(), lastUsedAt: Date.now() }] }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const pairing = createPairing({ dataDir })

    expect(pairing.pairedBrowserCount()).toBe(0)
    warn.mockRestore()
    pairing.issueToken(browser)
    expect(readStored(file).version).toBe(2)
  })

  it("ignores a pairing file that is a symlink", () => {
    const { dataDir, file } = createStore()
    const elsewhere = join(createStore().dataDir, "real.json")
    writeFileSync(elsewhere, JSON.stringify({ version: 2, browsers: [{ ...validEntry, lastUsedAt: Date.now() }] }))
    symlinkSync(elsewhere, file)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(createPairing({ dataDir }).pairedBrowserCount()).toBe(0)
    warn.mockRestore()
  })

  it("does not warn when there is no file yet", () => {
    const { dataDir } = createStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(createPairing({ dataDir }).pairedBrowserCount()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("throttles lastUsedAt writes to once an hour", () => {
    const { dataDir, file } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ dataDir, now: () => time })
    const token = pairing.issueToken(browser)
    const lastUsedOnDisk = () => readStored(file).browsers[0]?.lastUsedAt
    const paired = lastUsedOnDisk()

    for (let step = 0; step < 50; step++) {
      time += 60_000
      expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
    }
    expect(lastUsedOnDisk()).toBe(paired)

    time += hour
    expect(pairing.validateToken(token, editorOrigin)).toEqual(browser)
    expect(lastUsedOnDisk()).toBe(time)
  })

  it("forgets every pairing with forgetPairings", () => {
    const { dataDir, file } = createStore()
    const token = createPairing({ dataDir }).issueToken(browser)

    forgetPairings(dataDir)

    expect(() => statSync(file)).toThrow()
    const after = createPairing({ dataDir })
    expect(after.validateToken(token, editorOrigin)).toBeUndefined()
    expect(after.pairedBrowserCount()).toBe(0)
    expect(() => forgetPairings(dataDir)).not.toThrow()
  })

  it("creates the data dir when it is missing", () => {
    const { dataDir } = createStore()
    const nested = join(dataDir, "a", "b")
    mkdirSync(join(dataDir, "a"))

    createPairing({ dataDir: nested }).issueToken(browser)

    expect(statSync(join(nested, "pairing.json")).isFile()).toBe(true)
  })
})
