import { SecretStoreUnavailableError } from "./secretStore.ts"
import type { SecretStore } from "./secretStore.ts"

// The subset of @napi-rs/keyring's Entry that is used; tests pass a fake.
export interface KeychainEntry {
  getPassword(): string | null
  setPassword(password: string): void
  deletePassword(): boolean
}

export type KeychainEntryFactory = (service: string, account: string) => KeychainEntry

const serviceName = "prismic-local-agent-bridge"

async function loadNativeEntry(): Promise<KeychainEntryFactory> {
  try {
    const { Entry } = await import("@napi-rs/keyring")
    return (service, account) => new Entry(service, account)
  } catch {
    throw new SecretStoreUnavailableError("The OS keychain library isn't available on this platform")
  }
}

// The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) through @napi-rs/keyring.
// Resolves only when the keychain really works (a write, read and delete round trip with a throwaway entry), so the
// caller can fall back to a file store when it doesn't (a Linux box without a Secret Service, for instance).
export async function createKeychainSecretStore(args: {
  account: string
  entry?: KeychainEntryFactory
}): Promise<SecretStore> {
  const factory = args.entry ?? (await loadNativeEntry())
  const probe = factory(`${serviceName}-probe`, args.account)
  try {
    probe.setPassword("probe")
    if (probe.getPassword() !== "probe") throw new Error("round trip failed")
    probe.deletePassword()
  } catch {
    throw new SecretStoreUnavailableError("The OS keychain isn't usable")
  }

  const entry = factory(serviceName, args.account)
  return {
    backend: "keychain",
    async get() {
      try {
        return entry.getPassword() ?? undefined
      } catch {
        return undefined
      }
    },
    async set(value) {
      try {
        entry.setPassword(value)
      } catch {
        // The error text of a keychain failure can carry the platform's own detail: say only what failed.
        throw new Error("The OS keychain refused to store the key")
      }
    },
    async delete() {
      try {
        entry.deletePassword()
      } catch {
        throw new Error("The OS keychain refused to delete the key")
      }
    },
  }
}
