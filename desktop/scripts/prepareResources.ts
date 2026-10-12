// Builds what the app ships next to its own code: a Node runtime and the daemon (source and production
// dependencies, without the agents' native binaries, which the daemon downloads on first use).
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"

const nodeVersion = "24.15.0"
const nodeArchive = `node-v${nodeVersion}-darwin-arm64`
const nodeBaseUrl = `https://nodejs.org/dist/v${nodeVersion}`

const desktopDir = join(import.meta.dirname, "..")
const rootDir = join(desktopDir, "..")
const buildDir = join(desktopDir, "build")
const cacheDir = join(buildDir, "cache")
const runtimeDir = join(buildDir, "runtime")
const bridgeDir = join(buildDir, "bridge")

// `npm ci` installs the host's platform packages (the keychain binding), so the build must run on the target.
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The app is built on macOS Apple Silicon only")
}

await prepareNode()
prepareBridge()
console.info(`build/runtime: ${sizeOf(runtimeDir)}`)
console.info(`build/bridge: ${sizeOf(bridgeDir)}`)

async function prepareNode(): Promise<void> {
  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, `${nodeArchive}.tar.gz`)
  const sums = join(cacheDir, `SHASUMS256-${nodeVersion}.txt`)
  await downloadOnce(`${nodeBaseUrl}/${nodeArchive}.tar.gz`, archive)
  await downloadOnce(`${nodeBaseUrl}/SHASUMS256.txt`, sums)

  const line = readFileSync(sums, "utf8")
    .split("\n")
    .find((entry) => entry.endsWith(`  ${nodeArchive}.tar.gz`))
  if (line === undefined) throw new Error(`SHASUMS256.txt has no entry for ${nodeArchive}.tar.gz`)
  const expected = line.split(/\s+/)[0]
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex")
  if (actual !== expected) {
    rmSync(archive)
    throw new Error(`The Node archive doesn't match SHASUMS256.txt (expected ${expected}, got ${actual})`)
  }

  execFileSync("tar", ["-xzf", archive, "-C", cacheDir, `${nodeArchive}/bin/node`])
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })
  copyFileSync(join(cacheDir, nodeArchive, "bin", "node"), join(runtimeDir, "node"))
  chmodSync(join(runtimeDir, "node"), 0o755)
}

function prepareBridge(): void {
  rmSync(bridgeDir, { recursive: true, force: true })
  mkdirSync(bridgeDir, { recursive: true })
  copyFileSync(join(rootDir, "package.json"), join(bridgeDir, "package.json"))
  copyFileSync(join(rootDir, "package-lock.json"), join(bridgeDir, "package-lock.json"))
  // Tests are the only code importing from src/testing.
  cpSync(join(rootDir, "src"), join(bridgeDir, "src"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts") && !source.includes(`${sep}src${sep}testing`),
  })
  // In the lockfile, only dev dependencies have install scripts.
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: bridgeDir, stdio: "inherit" })

  // An upstream rename must not silently ship about 250 MB, or break the download on first use.
  for (const name of ["@openai/codex-darwin-arm64", "@anthropic-ai/claude-agent-sdk-darwin-arm64"]) {
    const path = join(bridgeDir, "node_modules", name)
    if (!existsSync(path)) throw new Error(`Expected ${name} in the daemon's node_modules: was it renamed?`)
    rmSync(path, { recursive: true, force: true })
  }
}

async function downloadOnce(url: string, to: string): Promise<void> {
  if (existsSync(to)) return
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!response.ok) throw new Error(`Download of ${url} failed (HTTP ${response.status})`)
  writeFileSync(to, Buffer.from(await response.arrayBuffer()))
}

function sizeOf(path: string): string {
  return execFileSync("du", ["-sh", path], { encoding: "utf8" }).split("\t")[0] ?? "?"
}
