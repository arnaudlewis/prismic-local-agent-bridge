import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SecretStoreUnavailableError } from "./secretStore.ts"
import type { SecretStore } from "./secretStore.ts"

const maxSecretFileBytes = 16 * 1024

// The fallback when there is no OS keychain: `<dataDir>/secrets/<name>`, mode 0600 in a 0700 directory, written
// atomically. A file that isn't a plain regular file (a symlink, a FIFO) is never read or replaced through.
export function createFileSecretStore(args: { dataDir: string; name: string }): SecretStore {
  const dir = join(args.dataDir, "secrets")
  const path = join(dir, args.name)

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const info = lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SecretStoreUnavailableError("The secrets path isn't a directory")
    chmodSync(dir, 0o700)
  }

  return {
    backend: "file",
    async get() {
      let info
      try {
        info = lstatSync(path)
      } catch {
        return undefined
      }
      if (!info.isFile() || info.size > maxSecretFileBytes) {
        console.warn("Ignoring the stored secret: not a regular file or too large")
        return undefined
      }
      try {
        const value = readFileSync(path, "utf8").trim()
        return value === "" ? undefined : value
      } catch {
        return undefined
      }
    },
    async set(value) {
      ensureDir()
      // Refuse to write through a symlink or a special file: rename() would replace it, but be explicit.
      try {
        const existing = lstatSync(path)
        if (!existing.isFile()) throw new SecretStoreUnavailableError("The stored secret path isn't a regular file")
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) throw error
      }
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, `${value}\n`, { mode: 0o600 })
      renameSync(temporaryPath, path)
    },
    async delete() {
      rmSync(path, { force: true })
    },
  }
}
