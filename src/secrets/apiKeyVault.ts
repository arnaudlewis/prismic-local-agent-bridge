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
  remove(): Promise<void>
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

  return {
    get,
    async set(key) {
      if (envKey() !== undefined) throw new KeyManagedByEnvironmentError()
      await store.set(key)
    },
    async remove() {
      if (envKey() !== undefined) throw new KeyManagedByEnvironmentError()
      await store.delete()
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
