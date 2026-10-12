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
  store: SecretStore
  // The environment variable that provides a read-only key, as it is when asked.
  env?: () => string | undefined
}

export function createApiKeyVault(args: CreateApiKeyVaultArgs): ApiKeyVault {
  const { store } = args
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

  async function storeKey(key: string): Promise<void> {
    if (envKey() !== undefined) throw new KeyManagedByEnvironmentError()
    // Before and after: whoever read the key while this runs must not trust what it read.
    credentialEpoch += 1
    await store.set(key)
    credentialEpoch += 1
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
        } finally {
          credentialEpoch += 1
        }
      })
    },
    storage: () => (envKey() === undefined ? store.backend : "env"),
    async status() {
      const found = await get()
      if (found === undefined) return { configured: false, storage: store.backend }
      return { configured: true, keyHint: `…${found.key.slice(-4)}`, storage: found.storage }
    },
    fingerprint: (key) => createHmac("sha256", salt).update(key).digest("hex").slice(0, 16),
  }
}

// The keychain when it works, else the private file.
export async function createDefaultSecretStore(args: {
  dataDir: string
  name: string
  keychainEntry?: KeychainEntryFactory
}): Promise<SecretStore> {
  try {
    return await createKeychainSecretStore({ account: args.name, entry: args.keychainEntry })
  } catch (error) {
    if (!(error instanceof SecretStoreUnavailableError)) throw error
    console.warn("No usable OS keychain: the Anthropic API key will be kept in a private file instead")
    return createFileSecretStore({ dataDir: args.dataDir, name: args.name })
  }
}
