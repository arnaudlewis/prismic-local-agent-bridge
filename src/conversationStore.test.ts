import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createConversationStore } from "./conversationStore.ts"
import type { StoredConversation } from "./conversationStore.ts"

const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function stored(): StoredConversation {
  return {
    version: 1,
    conversationId,
    repository: "repo",
    acpSessionId: "session-1",
    updatedAt: 1,
    events: [{ type: "user_message", text: "hello" }],
  }
}

function createStore() {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-store-"))
  return { dataDir, store: createConversationStore({ dataDir }) }
}

describe("createConversationStore", () => {
  it("round-trips a conversation in a private file inside a private directory", () => {
    const { dataDir, store } = createStore()
    store.save(stored())

    expect(store.load(conversationId)).toEqual(stored())
    expect(statSync(join(dataDir, "conversations", `${conversationId}.json`)).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, "conversations")).mode & 0o777).toBe(0o700)
  })

  it("ignores a corrupt file with a warning instead of throwing", () => {
    const { dataDir, store } = createStore()
    mkdirSync(join(dataDir, "conversations"), { recursive: true })
    writeFileSync(join(dataDir, "conversations", `${conversationId}.json`), '{"version":1,"events":"nope"}')
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(store.load(conversationId)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("returns undefined without a warning when there is no file", () => {
    const { store } = createStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(store.load(conversationId)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("refuses ids that are not strict UUID v4", () => {
    const { store } = createStore()
    expect(() => store.load("../../etc/passwd")).toThrow()
    expect(() => store.remove("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toThrow()
  })

  it("removes a conversation", () => {
    const { dataDir, store } = createStore()
    store.save(stored())
    store.remove(conversationId)

    expect(existsSync(join(dataDir, "conversations", `${conversationId}.json`))).toBe(false)
  })

  it("prunes files older than 30 days and keeps recent ones", () => {
    const { dataDir, store } = createStore()
    const recentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    store.save(stored())
    store.save({ ...stored(), conversationId: recentId })
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    utimesSync(join(dataDir, "conversations", `${conversationId}.json`), old, old)

    store.pruneOldFiles(Date.now())

    expect(existsSync(join(dataDir, "conversations", `${conversationId}.json`))).toBe(false)
    expect(existsSync(join(dataDir, "conversations", `${recentId}.json`))).toBe(true)
  })

  it("ignores a file over 4 MiB without parsing it", () => {
    const { dataDir, store } = createStore()
    mkdirSync(join(dataDir, "conversations"), { recursive: true })
    writeFileSync(join(dataDir, "conversations", `${conversationId}.json`), `${JSON.stringify(stored())}${" ".repeat(4 * 1024 * 1024)}`)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(store.load(conversationId)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("ignores a symlink even when it points at a valid conversation", () => {
    const { dataDir, store } = createStore()
    store.save(stored())
    const real = join(dataDir, "conversations", `${conversationId}.json`)
    const otherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    symlinkSync(real, join(dataDir, "conversations", `${otherId}.json`))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(store.load(otherId)).toBeUndefined()
    warn.mockRestore()
  })

  it("ignores a file whose events exceed the schema bounds, without logging its content", () => {
    const { dataDir, store } = createStore()
    mkdirSync(join(dataDir, "conversations"), { recursive: true })
    const oversized = { ...stored(), events: [{ type: "user_message", text: "SECRET".repeat(30_000) }] }
    const tooMany = { ...stored(), events: Array.from({ length: 5001 }, () => ({ type: "turn_end", stopReason: "end_turn" })) }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    for (const file of [oversized, tooMany]) {
      writeFileSync(join(dataDir, "conversations", `${conversationId}.json`), JSON.stringify(file))
      expect(store.load(conversationId)).toBeUndefined()
    }
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET")
    warn.mockRestore()
  })
})
