import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createPairing, forgetPairings } from "./pairing.ts"

function wrongCodeFor(code: string): string {
  return code === "000000" ? "111111" : "000000"
}

describe("createPairing", () => {
  it("returns a valid token for the right code and rotates the code", () => {
    const onCodeChanged = vi.fn()
    const pairing = createPairing({ onCodeChanged })
    const oldCode = pairing.currentCode()

    const token = pairing.tryPair(oldCode)

    expect(token).toBeDefined()
    expect(pairing.isValidToken(token ?? "")).toBe(true)
    expect(pairing.isValidToken("unknown")).toBe(false)
    expect(onCodeChanged).toHaveBeenCalledTimes(1)
    expect(pairing.currentCode()).not.toBe(oldCode)
    expect(pairing.tryPair(oldCode)).toBeUndefined()
  })

  it("rotates the code after 5 wrong attempts", () => {
    const onCodeChanged = vi.fn()
    const pairing = createPairing({ onCodeChanged })
    const oldCode = pairing.currentCode()
    const wrongCode = wrongCodeFor(oldCode)

    for (let attempt = 0; attempt < 4; attempt++) {
      expect(pairing.tryPair(wrongCode)).toBeUndefined()
    }
    expect(onCodeChanged).not.toHaveBeenCalled()

    expect(pairing.tryPair(wrongCode)).toBeUndefined()
    expect(onCodeChanged).toHaveBeenCalledTimes(1)
    expect(onCodeChanged).toHaveBeenCalledWith(pairing.currentCode())
    expect(pairing.currentCode()).not.toBe(oldCode)
  })

  it("rejects codes of a different length", () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    expect(pairing.tryPair("12")).toBeUndefined()
  })

  it("enforces a doubling cooldown across code rotations", () => {
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })

    function failBatch(): void {
      const wrongCode = wrongCodeFor(pairing.currentCode())
      for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
    }

    expect(pairing.cooldownRemainingMs()).toBe(0)
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(30_000)

    expect(pairing.tryPair(pairing.currentCode())).toBeUndefined()

    time += 30_000
    expect(pairing.cooldownRemainingMs()).toBe(0)
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(60_000)

    time += 60_000
    failBatch()
    expect(pairing.cooldownRemainingMs()).toBe(120_000)
  })

  it("caps the cooldown at 15 minutes and resets it after a successful pair", () => {
    let time = 0
    const pairing = createPairing({ onCodeChanged: () => {}, now: () => time })

    for (let batch = 0; batch < 12; batch++) {
      const wrongCode = wrongCodeFor(pairing.currentCode())
      for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
      expect(pairing.cooldownRemainingMs()).toBeLessThanOrEqual(15 * 60_000)
      time += pairing.cooldownRemainingMs()
    }

    const wrongCode = wrongCodeFor(pairing.currentCode())
    for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(wrongCode)
    expect(pairing.cooldownRemainingMs()).toBe(15 * 60_000)
    time += 15 * 60_000

    expect(pairing.tryPair(pairing.currentCode())).toBeDefined()

    const afterSuccess = wrongCodeFor(pairing.currentCode())
    for (let attempt = 0; attempt < 5; attempt++) pairing.tryPair(afterSuccess)
    expect(pairing.cooldownRemainingMs()).toBe(30_000)
  })
})

const day = 24 * 60 * 60 * 1000
const hour = 60 * 60 * 1000

function createStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-pairing-"))
  return { dataDir, file: join(dataDir, "pairing.json") }
}

function pairOnce(pairing: ReturnType<typeof createPairing>): string {
  const token = pairing.tryPair(pairing.currentCode())
  if (token === undefined) throw new Error("pairing failed")
  return token
}

describe("persistent pairing", () => {
  it("keeps a paired browser across a new instance on the same dir, and rotates the code as before", () => {
    const { dataDir } = createStore()
    const first = createPairing({ onCodeChanged: () => {}, dataDir })
    const token = pairOnce(first)

    const second = createPairing({ onCodeChanged: () => {}, dataDir })

    expect(second.isValidToken(token)).toBe(true)
    expect(second.pairedBrowserCount()).toBe(1)
    expect(second.currentCode()).not.toBe(first.currentCode())
  })

  it("never writes the raw token, and writes the file with mode 0600", () => {
    const { dataDir, file } = createStore()
    const token = pairOnce(createPairing({ onCodeChanged: () => {}, dataDir }))

    const content = readFileSync(file, "utf8")
    expect(content).not.toContain(token)
    expect(JSON.parse(content)).toEqual({
      version: 1,
      tokens: [{ hash: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: expect.any(Number), lastUsedAt: expect.any(Number) }],
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("rejects unknown, empty, altered and truncated tokens", () => {
    const { dataDir } = createStore()
    const pairing = createPairing({ onCodeChanged: () => {}, dataDir })
    const token = pairOnce(pairing)

    expect(pairing.isValidToken("unknown")).toBe(false)
    expect(pairing.isValidToken("")).toBe(false)
    expect(pairing.isValidToken(`${token}x`)).toBe(false)
    expect(pairing.isValidToken(token.slice(0, -1))).toBe(false)
    expect(createPairing({ onCodeChanged: () => {}, dataDir }).isValidToken("unknown")).toBe(false)
  })

  it("expires a token unused for 30 days, at load and on check", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const first = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    const token = pairOnce(first)

    time += 29 * day
    expect(first.isValidToken(token)).toBe(true)
    time += 31 * day
    expect(first.isValidToken(token)).toBe(false)
    expect(first.pairedBrowserCount()).toBe(0)

    time = 5_000_000
    const second = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    const other = pairOnce(second)
    time += 31 * day
    const third = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    expect(third.pairedBrowserCount()).toBe(0)
    expect(third.isValidToken(other)).toBe(false)
  })

  it("keeps a token alive as long as it is used", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    const token = pairOnce(pairing)

    for (let step = 0; step < 4; step++) {
      time += 20 * day
      expect(pairing.isValidToken(token)).toBe(true)
    }
  })

  it("keeps at most 20 paired browsers and drops the least recently used one", () => {
    const { dataDir } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    const tokens: string[] = []
    for (let index = 0; index < 20; index++) {
      time += 1000
      tokens.push(pairOnce(pairing))
    }
    time += 1000
    expect(pairing.isValidToken(tokens[0] ?? "")).toBe(true)

    time += 1000
    const newest = pairOnce(pairing)

    expect(pairing.pairedBrowserCount()).toBe(20)
    expect(pairing.isValidToken(tokens[1] ?? "")).toBe(false)
    expect(pairing.isValidToken(tokens[0] ?? "")).toBe(true)
    expect(pairing.isValidToken(newest)).toBe(true)
    expect(createPairing({ onCodeChanged: () => {}, dataDir, now: () => time }).pairedBrowserCount()).toBe(20)
  })

  const validEntry = { hash: "a".repeat(64), createdAt: 1, lastUsedAt: 1 }

  // Each fixture is valid JSON (except the first) with one specific wrong shape, so zod is what rejects it. The
  // marker sits in a string the schema would reject or ignore, to prove warnings never print file content.
  it.each([
    ["invalid JSON", "{not json SECRET-CONTENT"],
    ["wrong version", JSON.stringify({ version: 2, tokens: [], note: "SECRET-CONTENT" })],
    ["tokens is not an array", JSON.stringify({ version: 1, tokens: "SECRET-CONTENT" })],
    ["a non-hex hash", JSON.stringify({ version: 1, tokens: [{ ...validEntry, hash: "SECRET-CONTENT" }] })],
    ["a short hash", JSON.stringify({ version: 1, tokens: [{ ...validEntry, hash: "abc123" }] })],
    ["a missing lastUsedAt", JSON.stringify({ version: 1, tokens: [{ hash: "a".repeat(64), createdAt: 1 }] })],
    ["a string timestamp", JSON.stringify({ version: 1, tokens: [{ ...validEntry, createdAt: "SECRET-CONTENT" }] })],
    ["21 entries", JSON.stringify({ version: 1, tokens: Array.from({ length: 21 }, () => validEntry) })],
    ["a top-level array", JSON.stringify([validEntry, "SECRET-CONTENT"])],
    ["null", "null"],
    ["oversized", JSON.stringify({ version: 1, tokens: [], note: "SECRET-CONTENT".repeat(6000) })],
  ])("ignores a corrupt file (%s) with a warning that does not print its content", (_name, content) => {
    const { dataDir, file } = createStore()
    writeFileSync(file, content)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const pairing = createPairing({ onCodeChanged: () => {}, dataDir })

    expect(pairing.pairedBrowserCount()).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET-CONTENT")
    warn.mockRestore()
    expect(pairOnce(pairing)).toBeTruthy()
  })

  it("accepts a well-formed file, so the corrupt cases above fail for their own reason", () => {
    const { dataDir, file } = createStore()
    writeFileSync(file, JSON.stringify({ version: 1, tokens: [{ ...validEntry, lastUsedAt: Date.now() }] }))

    expect(createPairing({ onCodeChanged: () => {}, dataDir }).pairedBrowserCount()).toBe(1)
  })

  it("ignores a pairing file that is a symlink", () => {
    const { dataDir, file } = createStore()
    const elsewhere = join(createStore().dataDir, "real.json")
    writeFileSync(elsewhere, JSON.stringify({ version: 1, tokens: [{ hash: "a".repeat(64), createdAt: 1, lastUsedAt: 1 }] }))
    symlinkSync(elsewhere, file)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(createPairing({ onCodeChanged: () => {}, dataDir }).pairedBrowserCount()).toBe(0)
    warn.mockRestore()
  })

  it("does not warn when there is no file yet", () => {
    const { dataDir } = createStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(createPairing({ onCodeChanged: () => {}, dataDir }).pairedBrowserCount()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("throttles lastUsedAt writes to once an hour", () => {
    const { dataDir, file } = createStore()
    let time = 1_000_000
    const pairing = createPairing({ onCodeChanged: () => {}, dataDir, now: () => time })
    const token = pairOnce(pairing)
    const lastUsedOnDisk = () => (JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<{ lastUsedAt: number }> }).tokens[0]?.lastUsedAt
    const paired = lastUsedOnDisk()

    for (let step = 0; step < 50; step++) {
      time += 60_000
      expect(pairing.isValidToken(token)).toBe(true)
    }
    expect(lastUsedOnDisk()).toBe(paired)

    time += hour
    expect(pairing.isValidToken(token)).toBe(true)
    expect(lastUsedOnDisk()).toBe(time)
  })

  it("forgets every pairing with forgetPairings", () => {
    const { dataDir, file } = createStore()
    const token = pairOnce(createPairing({ onCodeChanged: () => {}, dataDir }))

    forgetPairings(dataDir)

    expect(() => statSync(file)).toThrow()
    const after = createPairing({ onCodeChanged: () => {}, dataDir })
    expect(after.isValidToken(token)).toBe(false)
    expect(after.pairedBrowserCount()).toBe(0)
    expect(() => forgetPairings(dataDir)).not.toThrow()
  })

  it("keeps the in-memory behavior and the failure cooldown when there is no data dir", () => {
    const pairing = createPairing({ onCodeChanged: () => {} })
    const token = pairOnce(pairing)
    expect(pairing.isValidToken(token)).toBe(true)
    expect(createPairing({ onCodeChanged: () => {} }).isValidToken(token)).toBe(false)
  })

  it("creates the data dir when it is missing", () => {
    const { dataDir } = createStore()
    const nested = join(dataDir, "a", "b")
    mkdirSync(join(dataDir, "a"))

    pairOnce(createPairing({ onCodeChanged: () => {}, dataDir: nested }))

    expect(statSync(join(nested, "pairing.json")).isFile()).toBe(true)
  })
})
