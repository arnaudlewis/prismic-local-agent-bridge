import { closeSync, fsyncSync, lstatSync, openSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"

import { ensureSecretsDir } from "./fileStore.ts"

// A durable "a copy of the key may still sit in a backend that couldn't be reached": the OS keychain was away when the
// key was replaced or removed. While it is set, that backend must not be read; it is cleared only once the copy is
// really deleted.
export interface RevocationMarker {
  // Fails closed: anything but a clean "not there" counts as set.
  isSet(): boolean
  // Durable before it returns. Throws when it can't be written: the caller must not report success.
  record(): void
  clear(): void
}

export function createRevocationMarker(args: { dataDir: string; name: string }): RevocationMarker {
  const path = join(args.dataDir, "secrets", args.name)

  function exists(): boolean {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT"
    }
  }

  return {
    isSet: exists,
    record() {
      if (exists()) return
      ensureSecretsDir(args.dataDir)
      const descriptor = openSync(path, "wx", 0o600)
      try {
        writeSync(descriptor, "pending\n")
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    },
    clear() {
      rmSync(path, { force: true })
    },
  }
}
