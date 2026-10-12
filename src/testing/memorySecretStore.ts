import type { SecretStore } from "../secrets/secretStore.ts"

export function createMemorySecretStore(initial?: string, backend: "keychain" | "file" = "keychain"): SecretStore & { value(): string | undefined } {
  let current = initial
  return {
    backend,
    get: () => Promise.resolve(current),
    set(value) {
      current = value
      return Promise.resolve()
    },
    delete() {
      current = undefined
      return Promise.resolve()
    },
    value: () => current,
  }
}
