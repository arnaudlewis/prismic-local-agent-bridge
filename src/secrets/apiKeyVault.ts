import { createHmac, randomBytes } from "node:crypto"

import { createFileSecretStore } from "./fileStore.ts"
import { createKeychainSecretStore } from "./keychainStore.ts"
import type { KeychainEntryFactory } from "./keychainStore.ts"
import { SecretStoreUnavailableError } from "./secretStore.ts"
import type { SecretStore } from "./secretStore.ts"

export type KeyStorage = "keychain" | "file" | "env"

export interface StoredKey {
  key: string
  storage: KeyStorage
}

// Raised by set()/remove() when the key comes from the environment: the browser can't change it.
export class KeyManagedByEnvironmentError extends Error {}

// The Anthropic API key, from wherever it lives. ANTHROPIC_API_KEY on the daemon wins and is read-only; otherwise
// the key is in the OS keychain, or in a private file when there is no keychain. The key never leaves this object
// except through get(): status() has only a hint (its last 4 characters) and a salted fingerprint of the key.
export interface ApiKeyVault {
  get(): Promise<StoredKey | undefined>
  set(key: string): Promise<void>
  // Admits a mutation (a PUT): bumps the mutation epoch and returns it. Any earlier mutation still waiting on
  // something slow (Anthropic's answer) is superseded.
  beginMutation(): number
  // Stores the key only if no other mutation (a DELETE, another PUT) was admitted since `epoch` was returned.
  // Resolves false, storing nothing, when superseded.
  setIfCurrent(key: string, epoch: number): Promise<boolean>
  // Admits a removal at once (it supersedes every mutation in flight, and invalidates credentials that were just
  // read), then removes the key. Everything that changes the stored key runs one at a time.
  remove(): Promise<void>
  // Bumped whenever the stored key may have changed. A starting agent that read its credentials at an older value
  // must not be started with them.
  credentialEpoch(): number
  // Where a key would be kept if one were set now.
  storage(): KeyStorage
  status(): Promise<{ configured: boolean; keyHint?: string; storage: KeyStorage; error?: string }>
  // Changes whenever the key does and says nothing about it (HMAC with a random per-process salt).
  fingerprint(key: string): string
}

interface CreateApiKeyVaultArgs {
  // The store in use: where keys are written and read.
  store: SecretStore
  // Every other place a copy of the key could be (the file when the keychain is in use, and the other way round).
  // The keychain can be unavailable on one run and available on the next: a key removed or replaced on one backend
  // must not come back from the other. They are cleaned on every set and remove, and never read from.
  otherStores?: SecretStore[]
  // The environment variable that provides a read-only key, as it is when asked.
  env?: () => string | undefined
}

export function createApiKeyVault(args: CreateApiKeyVaultArgs): ApiKeyVault {
  const { store } = args
  const otherStores = args.otherStores ?? []
  let warnedAboutOtherBackend = false
  const readEnv = args.env ?? (() => process.env.ANTHROPIC_API_KEY)
  const salt = randomBytes(32)
  let mutationEpoch = 0
  let credentialEpoch = 0
  let queue: Promise<unknown> = Promise.resolve()

  // Mutations of the stored key are serialized: a write never interleaves with a removal.
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run)
    queue = result.catch(() => {})
    return result
  }

  function envKey(): string | undefined {
    const value = readEnv()?.trim()
    return value === undefined || value === "" ? undefined : value
  }

  async function get(): Promise<StoredKey | undefined> {
    const fromEnv = envKey()
    if (fromEnv !== undefined) return { key: fromEnv, storage: "env" }
    const stored = await store.get()
    return stored === undefined ? undefined : { key: stored, storage: store.backend }
  }

  // Best effort, and never a word about the content: an error here must not stop a removal or a replacement.
  async function clearOtherStores(): Promise<void> {
    for (const other of otherStores) {
      try {
        await other.delete()
      } catch {
        console.warn(`Could not remove a copy of the Anthropic API key kept in the ${other.backend} backend`)
      }
    }
  }

  async function storeKey(key: string): Promise<void> {
    if (envKey() !== undefined) throw new KeyManagedByEnvironmentError()
    // Before and after: whoever read the key while this runs must not trust what it read.
    credentialEpoch += 1
    await store.set(key)
    await clearOtherStores()
    credentialEpoch += 1
  }

  // A key that is only in another backend (the keychain came or went since it was stored) is not used: the user adds
  // it again, or deletes it. Says so, once, without the key.
  async function otherBackendWithKey(): Promise<SecretStore | undefined> {
    for (const other of otherStores) {
      let found: string | undefined
      try {
        found = await other.get()
      } catch {
        continue
      }
      if (found !== undefined) {
        if (!warnedAboutOtherBackend) {
          warnedAboutOtherBackend = true
          console.warn(otherBackendMessage(other.backend))
        }
        return other
      }
    }
    return undefined
  }

  return {
    get,
    credentialEpoch: () => credentialEpoch,
    beginMutation: () => (mutationEpoch += 1),
    set: (key) => exclusive(() => storeKey(key)),
    setIfCurrent(key, epoch) {
      return exclusive(async () => {
        if (mutationEpoch !== epoch) return false
        await storeKey(key)
        return true
      })
    },
    remove() {
      // Synchronously, so that it also supersedes a PUT that is about to store its key.
      mutationEpoch += 1
      credentialEpoch += 1
      return exclusive(async () => {
        if (envKey() !== undefined) throw new KeyManagedByEnvironmentError()
        try {
          await store.delete()
          await clearOtherStores()
        } finally {
          credentialEpoch += 1
        }
      })
    },
    storage: () => (envKey() === undefined ? store.backend : "env"),
    async status() {
      const found = await get()
      if (found === undefined) {
        const other = await otherBackendWithKey()
        return {
          configured: false,
          storage: store.backend,
          ...(other === undefined ? {} : { error: otherBackendMessage(other.backend) }),
        }
      }
      return { configured: true, keyHint: `…${found.key.slice(-4)}`, storage: found.storage }
    },
    fingerprint: (key) => createHmac("sha256", salt).update(key).digest("hex").slice(0, 16),
  }
}

function otherBackendMessage(backend: SecretStore["backend"]): string {
  return `Found an Anthropic API key stored in the ${backend}; add it again from the panel or delete it`
}

// The keychain when it works, else the private file.
const keychainCleanupMarker = "keychain-cleanup-pending"

// Stands in for the keychain while it is unavailable: it holds nothing, and "deleting" from it leaves a marker, so
// that the keychain's own copy (which can't be reached now) is removed the next time the keychain works.
function createPendingKeychainCleanup(dataDir: string): SecretStore {
  const marker = createFileSecretStore({ dataDir, name: keychainCleanupMarker })
  return {
    backend: "keychain",
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => marker.set("pending"),
  }
}

// The store in use (the OS keychain when it works, else the private file) and the other one, which only ever gets
// cleaned (see otherStores). The keychain can come and go between runs: a removal or replacement made while it was
// away is applied to its copy as soon as it is back.
export async function createDefaultSecretStores(args: {
  dataDir: string
  name: string
  keychainEntry?: KeychainEntryFactory
}): Promise<{ store: SecretStore; otherStores: SecretStore[] }> {
  const file = createFileSecretStore({ dataDir: args.dataDir, name: args.name })
  try {
    const keychain = await createKeychainSecretStore({ account: args.name, entry: args.keychainEntry })
    const marker = createFileSecretStore({ dataDir: args.dataDir, name: keychainCleanupMarker })
    if ((await marker.get()) !== undefined) {
      try {
        await keychain.delete()
        await marker.delete()
      } catch {
        console.warn("Could not remove an old copy of the Anthropic API key from the OS keychain")
      }
    }
    return { store: keychain, otherStores: [file] }
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailableError)) throw error
    console.warn("No usable OS keychain: the Anthropic API key will be kept in a private file instead")
    return { store: file, otherStores: [createPendingKeychainCleanup(args.dataDir)] }
  }
}
