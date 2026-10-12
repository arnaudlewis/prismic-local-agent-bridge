import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

// The native binary of an agent (Codex, Claude Code). A checkout has it in node_modules; the packaged desktop app
// ships without it (about 250 MB) and downloads the exact version package-lock.json pins the first time it is needed.
export interface AgentRuntime {
  // Shown before a download, e.g. "about 120 MB".
  readonly sizeLabel: string
  // True when the binary can be spawned without downloading anything.
  isReady(): boolean
  // Points the ACP adapter at the downloaded binary; {} when node_modules has it.
  env(): Record<string, string>
  // Where the binary is when it can be run now (downloaded, or in node_modules), else undefined.
  binaryPath(): string | undefined
  // Downloads, checks and unpacks the package once; concurrent calls share one download. Rejects with a short reason.
  ensure(): Promise<void>
}

export interface CreateAgentRuntimeArgs {
  dataDir: string
  // Where package.json, package-lock.json and node_modules are.
  rootDir: string
  // Lockfile key without "node_modules/", e.g. "@openai/codex-darwin-arm64".
  packageName: string
  // Path of the binary inside the package.
  executable: string
  envName: "CODEX_PATH" | "CLAUDE_CODE_EXECUTABLE"
  sizeLabel: string
}

const downloadTimeoutMs = 15 * 60_000
const completeMarker = ".complete"
// A download is bounded by downloadTimeoutMs: anything untouched for longer is left over from a killed daemon.
const staleLeftoverMs = 30 * 60_000

export const daemonRootDir = fileURLToPath(new URL("../../", import.meta.url))

interface LockedPackage {
  version: string
  resolved: string
  integrity: string
}

export function createAgentRuntime(args: CreateAgentRuntimeArgs): AgentRuntime {
  const { dataDir, rootDir, packageName, executable, envName, sizeLabel } = args

  const installedInNodeModules = existsSync(join(rootDir, "node_modules", packageName, "package.json"))
  const locked = installedInNodeModules ? undefined : readLockedPackage(rootDir, packageName)
  if (locked === undefined) {
    // In node_modules, or a platform the lockfile doesn't list (the SDK finds its own binary there).
    const binaryPath = installedInNodeModules ? join(rootDir, "node_modules", packageName, executable) : undefined
    return { sizeLabel, isReady: () => true, env: () => ({}), binaryPath: () => binaryPath, ensure: () => Promise.resolve() }
  }

  const runtimesDir = join(dataDir, "runtimes")
  const name = packageName.replace(/^@/, "").replace("/", "+")
  const target = join(runtimesDir, `${name}@${locked.version}`)
  // Temporary names carry the runtime's name: Codex and Claude download side by side in the same directory.
  const downloadPrefix = `.download-${name}-`
  const unpackPrefix = `.unpack-${name}-`
  let pending: Promise<void> | undefined

  const isReady = () => existsSync(join(target, completeMarker))

  return {
    sizeLabel,
    isReady,
    env: () => (isReady() ? { [envName]: join(target, executable) } : {}),
    binaryPath: () => (isReady() ? join(target, executable) : undefined),
    ensure() {
      if (isReady()) return Promise.resolve()
      if (pending === undefined) {
        const attempt = download().finally(() => {
          if (pending === attempt) pending = undefined
        })
        pending = attempt
      }
      return pending
    },
  }

  async function download(): Promise<void> {
    if (locked === undefined) return
    mkdirSync(runtimesDir, { recursive: true, mode: 0o700 })
    removeStaleLeftovers()

    const archive = join(runtimesDir, `${downloadPrefix}${randomUUID()}.tgz`)
    const unpackDir = join(runtimesDir, `${unpackPrefix}${randomUUID()}`)
    try {
      await fetchChecked({ url: locked.resolved, integrity: locked.integrity, to: archive })
      mkdirSync(unpackDir, { mode: 0o700 })
      await unpack({ archive, to: unpackDir })
      if (!existsSync(join(unpackDir, executable))) throw new Error(`the package has no ${executable}`)
      writeFileSync(join(unpackDir, completeMarker), "")
      try {
        renameSync(unpackDir, target)
      } catch (error) {
        // Another daemon finished first: its copy is as good as ours.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error
      }
    } finally {
      rmSync(archive, { force: true })
      rmSync(unpackDir, { recursive: true, force: true })
    }
    removeOtherVersions()
  }

  // What a killed download left behind. Entries touched recently may belong to a download in progress in another
  // daemon on the same data directory, so they stay.
  function removeStaleLeftovers(): void {
    for (const entry of readdirSync(runtimesDir)) {
      if (!entry.startsWith(downloadPrefix) && !entry.startsWith(unpackPrefix)) continue
      const path = join(runtimesDir, entry)
      try {
        if (Date.now() - statSync(path).mtimeMs > staleLeftoverMs) rmSync(path, { recursive: true, force: true })
      } catch {
        // Gone in the meantime.
      }
    }
  }

  function removeOtherVersions(): void {
    for (const entry of readdirSync(runtimesDir)) {
      if (entry.startsWith(`${name}@`) && join(runtimesDir, entry) !== target) {
        rmSync(join(runtimesDir, entry), { recursive: true, force: true })
      }
    }
  }
}

interface FetchCheckedArgs {
  url: string
  // As in package-lock.json: space-separated "<algorithm>-<base64>" tokens.
  integrity: string
  to: string
}

async function fetchChecked(args: FetchCheckedArgs): Promise<void> {
  const { url, integrity, to } = args
  const expected = integrity.split(" ").find((token) => token.startsWith("sha512-"))
  if (expected === undefined) throw new Error("package-lock.json has no sha512 checksum for the download")

  const response = await fetch(url, { signal: AbortSignal.timeout(downloadTimeoutMs) })
  const { body } = response
  if (!response.ok || body === null) throw new Error(`download failed (HTTP ${response.status})`)

  const hash = createHash("sha512")
  await pipeline(
    async function* () {
      for await (const chunk of body) {
        hash.update(chunk)
        yield chunk
      }
    },
    createWriteStream(to, { flags: "wx", mode: 0o600 }),
  )
  if (`sha512-${hash.digest("base64")}` !== expected) throw new Error("the download doesn't match package-lock.json")
}

function unpack(args: { archive: string; to: string }): Promise<void> {
  const { archive, to } = args
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn("tar", ["-xzf", archive, "-C", to, "--strip-components", "1"], { stdio: "ignore" })
  const failed = () => reject(new Error("couldn't unpack the download"))
  child.on("error", failed)
  child.on("exit", (code) => (code === 0 ? resolve() : failed()))
  return promise
}

function readLockedPackage(rootDir: string, packageName: string): LockedPackage | undefined {
  let lock: unknown
  try {
    lock = JSON.parse(readFileSync(join(rootDir, "package-lock.json"), "utf8"))
  } catch {
    return undefined
  }
  const entry = (lock as { packages?: Record<string, Partial<LockedPackage> | undefined> } | null)?.packages?.[
    `node_modules/${packageName}`
  ]
  if (entry === undefined) return undefined
  const { version, resolved, integrity } = entry
  if (typeof version !== "string" || typeof resolved !== "string" || typeof integrity !== "string") return undefined
  return { version, resolved, integrity }
}

export function codexRuntimeArgs(): Omit<CreateAgentRuntimeArgs, "dataDir" | "rootDir"> {
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  }
  const platform = `${process.platform}-${process.arch}`
  const triple = triples[platform] ?? platform
  return {
    packageName: `@openai/codex-${platform}`,
    executable: `vendor/${triple}/bin/${process.platform === "win32" ? "codex.exe" : "codex"}`,
    envName: "CODEX_PATH",
    sizeLabel: "about 120 MB",
  }
}

export function claudeRuntimeArgs(): Omit<CreateAgentRuntimeArgs, "dataDir" | "rootDir"> {
  return {
    packageName: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    executable: process.platform === "win32" ? "claude.exe" : "claude",
    envName: "CLAUDE_CODE_EXECUTABLE",
    sizeLabel: "about 100 MB",
  }
}
