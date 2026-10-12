import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

interface ResolveProjectDirArgs {
  // The --project value, if given.
  explicit: string | undefined
  dataDir: string
}

export interface ProjectDir {
  path: string
  // True for the empty private workspace used when --project is absent.
  isDefaultWorkspace: boolean
}

export function resolveProjectDir(args: ResolveProjectDirArgs): ProjectDir {
  if (args.explicit !== undefined) {
    const path = resolve(args.explicit)
    if (!isDirectory(path)) throw new Error(`--project must be an existing directory: ${path}`)
    return { path, isDefaultWorkspace: false }
  }
  return { path: ensureDefaultWorkspace(join(args.dataDir, "workspace")), isDefaultWorkspace: true }
}

// An existing workspace is used as is: its content is never touched, since it may hold files the agent made.
function ensureDefaultWorkspace(path: string): string {
  let info: ReturnType<typeof lstatSync> | undefined
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (info === undefined) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
    return path
  }
  if (info.isSymbolicLink()) throw new Error(`The default workspace must not be a symlink: ${path}`)
  if (!info.isDirectory()) throw new Error(`The default workspace path exists and is not a directory: ${path}`)
  return path
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
