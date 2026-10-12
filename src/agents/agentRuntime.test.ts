import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createAgentRuntime } from "./agentRuntime.ts"
import type { CreateAgentRuntimeArgs } from "./agentRuntime.ts"

const packageName = "@fake/tool-pkg"
let workDir: string
let server: Server
let port: number
let requests: number
let status: number
let tarball: Buffer
let integrity: string
let rootDir: string
let dataDir: string

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "bridge-runtime-"))
  const source = join(workDir, "source")
  mkdirSync(join(source, "package", "bin"), { recursive: true })
  writeFileSync(join(source, "package", "package.json"), '{"name":"@fake/tool-pkg","version":"1.0.0"}')
  writeFileSync(join(source, "package", "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 })
  execFileSync("tar", ["-czf", join(workDir, "tool.tgz"), "-C", source, "package"])
  tarball = readFileSync(join(workDir, "tool.tgz"))
  integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`

  server = createServer((_req, res) => {
    requests += 1
    res.writeHead(status)
    res.end(status === 200 ? tarball : "nope")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  port = typeof address === "object" && address !== null ? address.port : 0
})

afterAll(async () => {
  server.close()
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
  requests = 0
  status = 200
  rootDir = mkdtempSync(join(workDir, "root-"))
  dataDir = mkdtempSync(join(workDir, "data-"))
  writeLock({ integrity })
})

function writeLock(args: { integrity: string } | undefined): void {
  const packages =
    args === undefined
      ? {}
      : {
          [`node_modules/${packageName}`]: {
            version: "1.0.0",
            resolved: `http://127.0.0.1:${port}/tool.tgz`,
            integrity: args.integrity,
          },
        }
  writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({ packages }))
}

function createRuntime() {
  const args: CreateAgentRuntimeArgs = {
    dataDir,
    rootDir,
    packageName,
    executable: "bin/tool",
    envName: "CODEX_PATH",
    sizeLabel: "about 1 MB",
  }
  return createAgentRuntime(args)
}

function runtimeEntries(): string[] {
  return existsSync(join(dataDir, "runtimes")) ? readdirSync(join(dataDir, "runtimes")) : []
}

describe("agent runtime", () => {
  it("needs nothing when node_modules has the package", async () => {
    mkdirSync(join(rootDir, "node_modules", packageName), { recursive: true })
    writeFileSync(join(rootDir, "node_modules", packageName, "package.json"), "{}")
    const runtime = createRuntime()

    expect(runtime.isReady()).toBe(true)
    expect(runtime.env()).toEqual({})
    await runtime.ensure()
    expect(requests).toBe(0)
  })

  it("needs nothing on a platform the lockfile doesn't list", () => {
    writeLock(undefined)
    const runtime = createRuntime()

    expect(runtime.isReady()).toBe(true)
    expect(runtime.env()).toEqual({})
  })

  it("downloads once for concurrent callers and points the adapter at the binary", async () => {
    const runtime = createRuntime()
    expect(runtime.isReady()).toBe(false)
    expect(runtime.env()).toEqual({})

    await Promise.all([runtime.ensure(), runtime.ensure()])

    const binary = join(dataDir, "runtimes", "fake+tool-pkg@1.0.0", "bin", "tool")
    expect(requests).toBe(1)
    expect(runtime.isReady()).toBe(true)
    expect(runtime.env()).toEqual({ CODEX_PATH: binary })
    expect(existsSync(binary)).toBe(true)
    expect(runtimeEntries()).toEqual(["fake+tool-pkg@1.0.0"])
  })

  it("refuses a download that doesn't match the lockfile, leaves nothing behind and tries again next time", async () => {
    writeLock({ integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` })
    const runtime = createRuntime()

    await expect(runtime.ensure()).rejects.toThrow("the download doesn't match package-lock.json")
    expect(runtimeEntries()).toEqual([])
    expect(runtime.isReady()).toBe(false)

    await expect(runtime.ensure()).rejects.toThrow("the download doesn't match package-lock.json")
    expect(requests).toBe(2)
  })

  it("reports an HTTP error", async () => {
    status = 404
    await expect(createRuntime().ensure()).rejects.toThrow("download failed (HTTP 404)")
    expect(runtimeEntries()).toEqual([])
  })

  it("removes older versions of the same package and nothing else", async () => {
    const runtimes = join(dataDir, "runtimes")
    mkdirSync(join(runtimes, "fake+tool-pkg@0.9.0"), { recursive: true })
    mkdirSync(join(runtimes, "other+pkg@1.0.0"), { recursive: true })

    await createRuntime().ensure()

    expect(runtimeEntries().sort()).toEqual(["fake+tool-pkg@1.0.0", "other+pkg@1.0.0"])
  })
})
