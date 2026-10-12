// Where a secret is kept. Values only ever leave through get(): they are never logged or put in an error.
export interface SecretStore {
  readonly backend: "keychain" | "file"
  // undefined when there is no secret (or it can't be read).
  get(): Promise<string | undefined>
  set(value: string): Promise<void>
  delete(): Promise<void>
}

// Thrown when a store can't be used at all (no keychain service, ...): the caller falls back to another one.
export class SecretStoreUnavailableError extends Error {}
