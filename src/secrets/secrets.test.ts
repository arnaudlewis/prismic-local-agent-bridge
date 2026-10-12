import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { KeyManagedByEnvironmentError, createApiKeyVault, createDefaultSecretStores } from "./apiKeyVault.ts"
import { createFileSecretStore } from "./fileStore.ts"
import { createKeychainSecretStore } from "./keychainStore.ts"
import type { KeychainEntry } from "./keychainStore.ts"
import { SecretStoreUnavailableError } from "./secretStore.ts"

const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bridge-secrets-"))
}

describe("file secret store", () => {
  it("stores the secret in a 0600 file inside a 0700 directory and reads it back", async () => {
    const dataDir = tempDir()
    const store = createFileSecretStore({ dataDir, name: "claude-api-key" })

    await store.set(key)

    expect(store.backend).toBe("file")
    expect(await store.get()).toBe(key)
    expect(statSync(join(dataDir, "secrets", "claude-api-key")).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, "secrets")).mode & 0o777).toBe(0o700)
  })

  it("tightens a directory that was created with looser permissions", async () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, "secrets"), { mode: 0o755 })

    await createFileSecretStore({ dataDir, name: "k" }).set(key)

    expect(statSync(join(dataDir, "secrets")).mode & 0o777).toBe(0o700)
  })

  it("replaces atomically: no temporary file is left and the old value is never half-written", async () => {
    const dataDir = tempDir()
    const store = createFileSecretStore({ dataDir, name: "k" })
    await store.set("first-value")

    await store.set("second-value")

    expect(await store.get()).toBe("second-value")
    expect(readdirSync(join(dataDir, "secrets"))).toEqual(["k"])
  })

  it("deletes, and deleting what isn't there is fine", async () => {
    const dataDir = tempDir()
    const store = createFileSecretStore({ dataDir, name: "k" })
    await store.set(key)

    await store.delete()
    await store.delete()

    expect(await store.get()).toBeUndefined()
    expect(existsSync(join(dataDir, "secrets", "k"))).toBe(false)
  })

  it("returns undefined when there is nothing stored", async () => {
    expect(await createFileSecretStore({ dataDir: tempDir(), name: "k" }).get()).toBeUndefined()
  })

  it("refuses to read through a symlink", async () => {
    const dataDir = tempDir()
    const elsewhere = join(tempDir(), "real")
    writeFileSync(elsewhere, key)
    mkdirSync(join(dataDir, "secrets"), { mode: 0o700 })
    symlinkSync(elsewhere, join(dataDir, "secrets", "k"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await createFileSecretStore({ dataDir, name: "k" }).get()).toBeUndefined()
    expect(warn.mock.calls.flat().join(" ")).not.toContain(key)
    warn.mockRestore()
  })

  it("refuses to write over a symlink and leaves its target alone", async () => {
    const dataDir = tempDir()
    const target = join(tempDir(), "target")
    writeFileSync(target, "untouched")
    mkdirSync(join(dataDir, "secrets"), { mode: 0o700 })
    symlinkSync(target, join(dataDir, "secrets", "k"))

    await expect(createFileSecretStore({ dataDir, name: "k" }).set(key)).rejects.toBeInstanceOf(SecretStoreUnavailableError)

    expect(readFileSync(target, "utf8")).toBe("untouched")
    expect(lstatSync(join(dataDir, "secrets", "k")).isSymbolicLink()).toBe(true)
  })

  it("refuses a secrets directory that is a symlink", async () => {
    const dataDir = tempDir()
    symlinkSync(tempDir(), join(dataDir, "secrets"))

    await expect(createFileSecretStore({ dataDir, name: "k" }).set(key)).rejects.toBeInstanceOf(SecretStoreUnavailableError)
  })

  it("ignores an oversized file", async () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, "secrets"), { mode: 0o700 })
    writeFileSync(join(dataDir, "secrets", "k"), "x".repeat(20 * 1024))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await createFileSecretStore({ dataDir, name: "k" }).get()).toBeUndefined()
    warn.mockRestore()
  })
})

function fakeEntry(overrides: Partial<KeychainEntry> = {}) {
  const items = new Map<string, string>()
  return (service: string, account: string): KeychainEntry => {
    const id = `${service}/${account}`
    return {
      getPassword: () => items.get(id) ?? null,
      setPassword: (password) => void items.set(id, password),
      deletePassword: () => items.delete(id),
      ...overrides,
    }
  }
}

describe("keychain secret store", () => {
  it("stores, reads and deletes through the keychain entry", async () => {
    const store = await createKeychainSecretStore({ account: "claude-api-key", entry: fakeEntry() })

    await store.set(key)
    expect(store.backend).toBe("keychain")
    expect(await store.get()).toBe(key)

    await store.delete()
    expect(await store.get()).toBeUndefined()
  })

  it("is unavailable when the keychain can't do a round trip", async () => {
    const broken = fakeEntry({
      setPassword: () => {
        throw new Error("no secret service")
      },
    })

    await expect(createKeychainSecretStore({ account: "a", entry: broken })).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    )
  })

  it("does not repeat the keychain's own error text, which could carry the secret", async () => {
    const entry = fakeEntry()
    const store = await createKeychainSecretStore({
      account: "a",
      entry: (service, account) =>
        service.endsWith("probe")
          ? entry(service, account)
          : { ...entry(service, account), setPassword: () => { throw new Error(`failed for ${key}`) } },
    })

    const error = await store.set(key).catch((caught: unknown) => caught)

    expect(String((error as Error).message)).not.toContain(key)
  })

  it("leaves nothing behind from its availability probe", async () => {
    const items = new Map<string, string>()
    const entry = (service: string, account: string): KeychainEntry => {
      const id = `${service}/${account}`
      return {
        getPassword: () => items.get(id) ?? null,
        setPassword: (password) => void items.set(id, password),
        deletePassword: () => items.delete(id),
      }
    }

    await createKeychainSecretStore({ account: "a", entry })

    expect(items.size).toBe(0)
  })

  it("works with the real OS keychain on this machine, or reports it unavailable (never throws anything else)", async () => {
    const outcome = await createKeychainSecretStore({ account: "selftest-never-set" }).catch((error: unknown) => error)

    expect(typeof outcome === "object" && outcome !== null).toBe(true)
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(SecretStoreUnavailableError)
  })
})

describe("default secret store", () => {
  it("falls back to the private file, with a warning, when there is no keychain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dataDir = tempDir()

    const { store } = await createDefaultSecretStores({
      dataDir,
      name: "claude-api-key",
      keychainEntry: fakeEntry({
        setPassword: () => {
          throw new Error("no keychain")
        },
      }),
    })

    expect(store.backend).toBe("file")
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("uses the keychain when it works", async () => {
    const { store, otherStores } = await createDefaultSecretStores({ dataDir: tempDir(), name: "k", keychainEntry: fakeEntry() })

    expect(store.backend).toBe("keychain")
    expect(otherStores.map((other) => other.backend)).toEqual(["file"])
  })
})

describe("api key vault", () => {
  function vault(args: { stored?: string; env?: string | undefined; backend?: "keychain" | "file" } = {}) {
    const store = createMemorySecretStore(args.stored, args.backend)
    return { store, vault: createApiKeyVault({ store, env: () => args.env }) }
  }

  it("reports a missing key with where one would be kept", async () => {
    expect(await vault().vault.status()).toEqual({ configured: false, storage: "keychain" })
    expect(await vault({ backend: "file" }).vault.status()).toEqual({ configured: false, storage: "file" })
  })

  it("reports a stored key as a hint of its last 4 characters, never the key", async () => {
    const { vault: v } = vault({ stored: key })

    const status = await v.status()

    expect(status).toEqual({ configured: true, keyHint: "…1234", storage: "keychain" })
    expect(JSON.stringify(status)).not.toContain(key)
  })

  it("stores and removes a key", async () => {
    const { vault: v, store } = vault()

    await v.set(key)
    expect(store.value()).toBe(key)
    expect(await v.get()).toEqual({ key, storage: "keychain" })

    await v.remove()
    expect(await v.get()).toBeUndefined()
  })

  it("lets ANTHROPIC_API_KEY win, read-only", async () => {
    const envKey = "sk-ant-api03-FROMTHEENVIRONMENT9999"
    const { vault: v, store } = vault({ stored: key, env: envKey })

    expect(await v.get()).toEqual({ key: envKey, storage: "env" })
    expect(await v.status()).toEqual({ configured: true, keyHint: "…9999", storage: "env" })
    expect(v.storage()).toBe("env")
    await expect(v.set(key)).rejects.toBeInstanceOf(KeyManagedByEnvironmentError)
    await expect(v.remove()).rejects.toBeInstanceOf(KeyManagedByEnvironmentError)
    expect(store.value()).toBe(key)
  })

  it("ignores an empty or blank environment variable", async () => {
    expect(await vault({ stored: key, env: "   " }).vault.get()).toEqual({ key, storage: "keychain" })
    expect(await vault({ env: "" }).vault.get()).toBeUndefined()
  })

  it("fingerprints the key without revealing it: stable, different per key, different per vault", () => {
    const first = vault().vault
    const second = vault().vault

    expect(first.fingerprint(key)).toBe(first.fingerprint(key))
    expect(first.fingerprint(key)).not.toBe(first.fingerprint(`${key}x`))
    expect(first.fingerprint(key)).not.toBe(second.fingerprint(key))
    expect(first.fingerprint(key)).toMatch(/^[0-9a-f]{16}$/)
    expect(first.fingerprint(key)).not.toContain(key.slice(-4))
  })

  describe("mutation and credential epochs", () => {
    function fresh(stored?: string) {
      const store = createMemorySecretStore(stored)
      return { store, vault: createApiKeyVault({ store, env: () => undefined }) }
    }

    it("hands out increasing mutation epochs", () => {
      const { vault: v } = fresh()

      const first = v.beginMutation()
      const second = v.beginMutation()

      expect(second).toBeGreaterThan(first)
    })

    it("stores through setIfCurrent only while its epoch is the latest", async () => {
      const { vault: v, store } = fresh()
      const mine = v.beginMutation()

      expect(await v.setIfCurrent(key, mine)).toBe(true)
      expect(store.value()).toBe(key)

      const stale = v.beginMutation()
      v.beginMutation()
      expect(await v.setIfCurrent("sk-ant-api03-STALESTALESTALESTALE0000", stale)).toBe(false)
      expect(store.value()).toBe(key)
    })

    it("supersedes the mutations in flight as soon as remove() is called, before it has run", async () => {
      const { vault: v, store } = fresh(key)
      const mine = v.beginMutation()

      const removal = v.remove()
      const stored = await v.setIfCurrent("sk-ant-api03-LATELATELATELATELATE0000", mine)
      await removal

      expect(stored).toBe(false)
      expect(store.value()).toBeUndefined()
    })

    it("runs a store and a removal one at a time, in the order they were admitted", async () => {
      const order: string[] = []
      const slow = createMemorySecretStore()
      const originalSet = slow.set
      slow.set = async (value) => {
        order.push("set:start")
        await new Promise((resolve) => setTimeout(resolve, 30))
        await originalSet(value)
        order.push("set:end")
      }
      const originalDelete = slow.delete
      slow.delete = async () => {
        order.push("delete")
        await originalDelete()
      }
      const v = createApiKeyVault({ store: slow, env: () => undefined })

      const stored = v.set(key)
      const removed = v.remove()
      await Promise.all([stored, removed])

      expect(order).toEqual(["set:start", "set:end", "delete"])
      expect(slow.value()).toBeUndefined()
    })

    it("bumps the credential epoch when the key is stored and when it is removed, before and after", async () => {
      const { vault: v } = fresh(key)
      const start = v.credentialEpoch()

      await v.set("sk-ant-api03-REPLACEDREPLACEDREPLACED7777")
      const afterSet = v.credentialEpoch()
      const removal = v.remove()
      const duringRemoval = v.credentialEpoch()
      await removal

      expect(afterSet).toBeGreaterThan(start)
      expect(duringRemoval).toBeGreaterThan(afterSet)
      expect(v.credentialEpoch()).toBeGreaterThan(duringRemoval)
    })

    it("keeps working after a failed store: the queue is not stuck", async () => {
      const { vault: v, store } = fresh()
      const originalSet = store.set
      store.set = () => Promise.reject(new Error("boom"))
      await expect(v.set(key)).rejects.toThrow("boom")
      store.set = originalSet

      await v.set(key)

      expect(store.value()).toBe(key)
    })
  })
})
