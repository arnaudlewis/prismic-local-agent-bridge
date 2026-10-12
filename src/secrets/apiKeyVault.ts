import { createHmac, randomBytes } from "node:crypto"

import { createFileSecretStore } from "./fileStore.ts"
import { createRevocationMarker } from "./revocationMarker.ts"
import type { RevocationMarker } from "./revocationMarker.ts"
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
  // Whether no other mutation was admitted since `epoch` was returned.
  isCurrentMutation(epoch: number): boolean
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
  // Every key this process has held (read, set or replaced): for redaction only, never sent anywhere.
  knownKeys(): string[]
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
  // Set when a backend that can't be reached now may still hold a copy (the keychain is away, or its cleanup
  // failed). Every set and remove records it first and fails if it can't: success is never reported without it.
  revocation?: RevocationMarker
  // A fixed, non-secret sentence for /status: why a backend is not in use.
  notice?: string
  // The environment variable that provides a read-only key, as it is when asked.
  env?: () => string | undefined
}

export function createApiKeyVault(args: CreateApiKeyVaultArgs): ApiKeyVault {
  const { store } = args
  const otherStores = args.otherStores ?? []
  const { revocation } = args
  let warnedAboutOtherBackend = false
  const readEnv = args.env ?? (() => process.env.ANTHROPIC_API_KEY)
  const salt = randomBytes(32)
  let mutationEpoch = 0
  let credentialEpoch = 0
  let queue: Promise<unknown> = Promise.resolve()
  const seenKeys = new Set<string>()

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
    if (fromEnv !== undefined) {
      seenKeys.add(fromEnv)
      return { key: fromEnv, storage: "env" }
    }
    const stored = await store.get()
    if (stored === undefined) return undefined
    seenKeys.add(stored)
    return { key: stored, storage: store.backend }
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
    seenKeys.add(key)
    revocation?.record()
    await store.set(key)
    await clearOtherStores()
    credentialEpoch += 1
  }

  // A key that is only in another backend (the keychain came or went since it was stored) is not used: the user adds
  // it again, or deletes it. Says so, once, without the key.
  async function otherBackendWithKey(selectedHasKey: boolean): Promise<SecretStore | undefined> {
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
          console.warn(selectedHasKey ? bothBackendsMessage(store.backend) : otherBackendMessage(other.backend))
        }
        return other
      }
    }
    return undefined
  }

  return {
    get,
    isCurrentMutation: (epoch) => epoch === mutationEpoch,
    knownKeys: () => [...seenKeys],
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
          revocation?.record()
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
      const other = await otherBackendWithKey(found !== undefined && found.storage !== "env")
      if (found === undefined) {
        return {
          configured: false,
          storage: store.backend,
          ...errorField(other === undefined ? args.notice : otherBackendMessage(other.backend)),
        }
      }
      const both = found.storage !== "env" && other !== undefined
      return {
        configured: true,
        keyHint: `…${found.key.slice(-4)}`,
        storage: found.storage,
        ...errorField(both ? bothBackendsMessage(found.storage) : args.notice),
      }
    },
    fingerprint: (key) => createHmac("sha256", salt).update(key).digest("hex").slice(0, 16),
  }
}

function errorField(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error }
}

function bothBackendsMessage(used: KeyStorage): string {
  return `Anthropic API keys are stored in both the keychain and the file; the one in the ${used} is used. Replace or delete the key to clean up the other`
}

function otherBackendMessage(backend: SecretStore["backend"]): string {
  return `Found an Anthropic API key stored in the ${backend}; add it again from the panel or delete it`
}

const keychainCleanupMarker = "keychain-cleanup-pending"
const quarantineNotice =
  "An old Anthropic API key in the OS keychain could not be removed, so the keychain is not used; remove that keychain item or restart the bridge to try again"

// The store in use (the OS keychain when it works, else the private file) and the other one, which only ever gets
// cleaned (see otherStores). The keychain can come and go between runs: a removal or replacement made while it was
// away is recorded, and the keychain is not read again until its copy is really deleted. If that deletion fails the
// keychain stays out of use (the file is used) and /status says so.
export async function createDefaultSecretStores(args: {
  dataDir: string
  name: string
  keychainEntry?: KeychainEntryFactory
}): Promise<{ store: SecretStore; otherStores: SecretStore[]; revocation?: RevocationMarker; notice?: string }> {
  const file = createFileSecretStore({ dataDir: args.dataDir, name: args.name })
  const marker = createRevocationMarker({ dataDir: args.dataDir, name: keychainCleanupMarker })
  let keychain: SecretStore
  try {
    keychain = await createKeychainSecretStore({ account: args.name, entry: args.keychainEntry })
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailableError)) throw error
    console.warn("No usable OS keychain: the Anthropic API key will be kept in a private file instead")
    return { store: file, otherStores: [], revocation: marker }
  }
  if (marker.isSet()) {
    try {
      await keychain.delete()
      marker.clear()
    } catch {
      console.warn("Could not remove an old copy of the Anthropic API key from the OS keychain: it is not used")
      return { store: file, otherStores: [], revocation: marker, notice: quarantineNotice }
    }
  }
  return { store: keychain, otherStores: [file] }
}
