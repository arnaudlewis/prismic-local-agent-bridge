import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createApiKeyVault, createDefaultSecretStores } from "./apiKeyVault.ts"
import { createFileSecretStore } from "./fileStore.ts"
import type { KeychainEntry } from "./keychainStore.ts"

const keyA = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA1111"
const keyB = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB2222"

// A pretend OS keychain that survives from one "run of the daemon" to the next, and that can be switched off.
function createKeychain() {
  const items = new Map<string, string>()
  let available = true
  let failDelete = false
  const factory = (service: string, account: string): KeychainEntry => {
    const id = `${service}/${account}`
    const guard = () => {
      if (!available) throw new Error("no keychain")
    }
    return {
      getPassword: () => (guard(), items.get(id) ?? null),
      setPassword: (password) => (guard(), void items.set(id, password)),
      deletePassword: () => {
        guard()
        if (failDelete && !id.includes("probe")) throw new Error("delete refused")
        return items.delete(id)
      },
    }
  }
  return {
    factory,
    setAvailable: (value: boolean) => void (available = value),
    setFailDelete: (value: boolean) => void (failDelete = value),
    content: () => [...items.entries()].filter(([id]) => !id.includes("probe")).map(([, value]) => value),
  }
}

// One "run of the daemon": the stores it would build, and the vault over them.
async function run(dataDir: string, keychain: ReturnType<typeof createKeychain>) {
  const stores = await createDefaultSecretStores({ dataDir, name: "claude-api-key", keychainEntry: keychain.factory })
  const vault = createApiKeyVault({ ...stores, env: () => undefined })
  return { vault, backend: stores.store.backend, file: createFileSecretStore({ dataDir, name: "claude-api-key" }) }
}

function quiet() {
  const logged: unknown[][] = []
  const spies = (["log", "info", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args)),
  )
  return { logged, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

describe("a key and the backends it can live in", () => {
  it("is written to the selected store and removed from the other one", async () => {
    const keychain = createKeychain()
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
    const file = createFileSecretStore({ dataDir, name: "claude-api-key" })
    await file.set(keyA)
    const log = quiet()

    const { vault, backend } = await run(dataDir, keychain)
    await vault.set(keyB)

    log.restore()
    expect(backend).toBe("keychain")
    expect(keychain.content()).toEqual([keyB])
    expect(await file.get()).toBeUndefined()
  })

  it("is removed from both stores", async () => {
    const keychain = createKeychain()
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
    const file = createFileSecretStore({ dataDir, name: "claude-api-key" })
    const { vault } = await run(dataDir, keychain)
    await vault.set(keyA)
    await file.set(keyA)

    await vault.remove()

    expect(keychain.content()).toEqual([])
    expect(await file.get()).toBeUndefined()
    expect(await vault.get()).toBeUndefined()
  })

  it("is not used from another backend: the user is told, and nothing is read", async () => {
    const keychain = createKeychain()
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
    await createFileSecretStore({ dataDir, name: "claude-api-key" }).set(keyA)
    const log = quiet()

    const { vault } = await run(dataDir, keychain)
    const status = await vault.status()
    await vault.status()

    expect(await vault.get()).toBeUndefined()
    expect(status).toEqual({
      configured: false,
      storage: "keychain",
      error: "Found an Anthropic API key stored in the file; add it again from the panel or delete it",
    })
    // Once, and without the key.
    const messages = log.logged.map((args) => String(args[0])).filter((message) => message.startsWith("Found an Anthropic API key"))
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(log.logged)).not.toContain(keyA)
    log.restore()
  })

  it("can be deleted from the panel even though it is only in the other backend", async () => {
    const keychain = createKeychain()
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
    const file = createFileSecretStore({ dataDir, name: "claude-api-key" })
    await file.set(keyA)
    const log = quiet()
    const { vault } = await run(dataDir, keychain)

    await vault.remove()

    log.restore()
    expect(await file.get()).toBeUndefined()
    expect((await vault.status()).error).toBeUndefined()
  })

  it("is not offered again after the user adds it from the panel (it is moved)", async () => {
    const keychain = createKeychain()
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
    const file = createFileSecretStore({ dataDir, name: "claude-api-key" })
    await file.set(keyA)
    const log = quiet()
    const { vault } = await run(dataDir, keychain)

    await vault.set(keyA)

    log.restore()
    expect(await vault.status()).toMatchObject({ configured: true, storage: "keychain" })
    expect(await file.get()).toBeUndefined()
  })

  describe("when the keychain comes and goes between runs", () => {
    it("does not bring back a key that was removed while the keychain was away", async () => {
      const keychain = createKeychain()
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
      const log = quiet()
      const first = await run(dataDir, keychain)
      await first.vault.set(keyA)
      expect(keychain.content()).toEqual([keyA])

      keychain.setAvailable(false)
      const second = await run(dataDir, keychain)
      expect(second.backend).toBe("file")
      expect(await second.vault.get()).toBeUndefined()
      await second.vault.remove()

      keychain.setAvailable(true)
      const third = await run(dataDir, keychain)

      log.restore()
      expect(third.backend).toBe("keychain")
      expect(keychain.content()).toEqual([])
      expect(await third.vault.get()).toBeUndefined()
      expect(existsSync(join(dataDir, "secrets", "keychain-cleanup-pending"))).toBe(false)
    })

    it("does not bring back a key that was replaced while the keychain was away", async () => {
      const keychain = createKeychain()
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
      const log = quiet()
      const first = await run(dataDir, keychain)
      await first.vault.set(keyA)

      keychain.setAvailable(false)
      const second = await run(dataDir, keychain)
      await second.vault.set(keyB)
      expect((await second.vault.get())?.key).toBe(keyB)

      keychain.setAvailable(true)
      const third = await run(dataDir, keychain)

      log.restore()
      // The old keychain copy is gone; the new key is in the file, so the user is asked to add it again.
      expect(keychain.content()).toEqual([])
      expect(await third.vault.get()).toBeUndefined()
      expect((await third.vault.status()).error).toContain("stored in the file")
    })

    it("keeps working when a copy can't be removed from the other backend, without saying what it holds", async () => {
      const keychain = createKeychain()
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
      const log = quiet()
      const { vault } = await run(dataDir, keychain)
      await vault.set(keyA)
      keychain.setFailDelete(true)
      const stores = await createDefaultSecretStores({ dataDir, name: "claude-api-key", keychainEntry: keychain.factory })
      const withBrokenKeychain = createApiKeyVault({ store: createFileSecretStore({ dataDir, name: "claude-api-key" }), otherStores: [stores.store] })

      await withBrokenKeychain.set(keyB)
      await withBrokenKeychain.remove()

      log.restore()
      expect(await withBrokenKeychain.get()).toBeUndefined()
      expect(JSON.stringify(log.logged)).not.toContain(keyA)
      expect(JSON.stringify(log.logged)).not.toContain(keyB)
      expect(log.logged.flat().join(" ")).toContain("Could not remove a copy of the Anthropic API key kept in the keychain backend")
    })

    it("starts from nothing on a machine that has never had a keychain", async () => {
      const keychain = createKeychain()
      keychain.setAvailable(false)
      const dataDir = mkdtempSync(join(tmpdir(), "bridge-backends-"))
      const log = quiet()

      const { vault, backend } = await run(dataDir, keychain)
      await vault.set(keyA)

      log.restore()
      expect(backend).toBe("file")
      expect(await vault.status()).toMatchObject({ configured: true, storage: "file" })
    })
  })
})
