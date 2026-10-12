import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { resolveProjectDir } from "./workspace.ts"

function createDataDir(): string {
  return mkdtempSync(join(tmpdir(), "bridge-workspace-"))
}

describe("resolveProjectDir", () => {
  it("creates the default workspace privately when --project is absent", () => {
    const dataDir = createDataDir()

    const project = resolveProjectDir({ explicit: undefined, dataDir })

    expect(project).toEqual({ path: join(dataDir, "workspace"), isDefaultWorkspace: true })
    expect(statSync(project.path).isDirectory()).toBe(true)
    expect(statSync(project.path).mode & 0o777).toBe(0o700)
  })

  it("creates missing parent directories of the data dir", () => {
    const dataDir = join(createDataDir(), "not", "yet", "there")

    const project = resolveProjectDir({ explicit: undefined, dataDir })

    expect(existsSync(project.path)).toBe(true)
  })

  it("reuses an existing default workspace without touching its content or mode", () => {
    const dataDir = createDataDir()
    const workspace = join(dataDir, "workspace")
    mkdirSync(workspace, { mode: 0o755 })
    writeFileSync(join(workspace, "notes.txt"), "keep me")

    const project = resolveProjectDir({ explicit: undefined, dataDir })

    expect(project.path).toBe(workspace)
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("keep me")
    expect(statSync(workspace).mode & 0o777).toBe(0o755)
  })

  it("rejects a default workspace path that is a file", () => {
    const dataDir = createDataDir()
    writeFileSync(join(dataDir, "workspace"), "x")

    expect(() => resolveProjectDir({ explicit: undefined, dataDir })).toThrow(/not a directory/)
  })

  it("rejects a default workspace path that is a symlink, even to a directory", () => {
    const dataDir = createDataDir()
    const elsewhere = createDataDir()
    symlinkSync(elsewhere, join(dataDir, "workspace"))

    expect(() => resolveProjectDir({ explicit: undefined, dataDir })).toThrow(/symlink/)
  })

  it("uses an explicit --project as is and does not create the default workspace", () => {
    const dataDir = createDataDir()
    const projectDir = createDataDir()

    const project = resolveProjectDir({ explicit: projectDir, dataDir })

    expect(project).toEqual({ path: projectDir, isDefaultWorkspace: false })
    expect(existsSync(join(dataDir, "workspace"))).toBe(false)
  })

  it("rejects an explicit --project that does not exist or is not a directory", () => {
    const dataDir = createDataDir()
    const file = join(createDataDir(), "file.txt")
    writeFileSync(file, "x")

    expect(() => resolveProjectDir({ explicit: join(dataDir, "missing"), dataDir })).toThrow(
      /--project must be an existing directory/,
    )
    expect(() => resolveProjectDir({ explicit: file, dataDir })).toThrow(/--project must be an existing directory/)
  })
})
