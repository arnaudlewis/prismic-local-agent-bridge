import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { describeClaudeCodeLogin } from "./claudeCodeLogin.ts"

// A stand-in for `claude`: prints what `claude auth status` would.
function fakeClaude(output: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "bridge-claude-login-")), "claude")
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`)
  chmodSync(path, 0o755)
  return path
}

describe("describeClaudeCodeLogin", () => {
  it("names the account and the subscription of a signed-in Claude Code", async () => {
    const binaryPath = fakeClaude('{"loggedIn": true, "email": "me@example.com", "subscriptionType": "max"}')

    expect(await describeClaudeCodeLogin({ binaryPath })).toBe("Claude: me@example.com (max)")
  })

  it("says so when Claude Code isn't signed in", async () => {
    const binaryPath = fakeClaude('{"loggedIn": false, "authMethod": "none"}')

    expect(await describeClaudeCodeLogin({ binaryPath })).toBe("Claude: Claude Code isn't signed in")
  })

  it("doesn't pretend to know when the answer can't be read or the binary isn't there yet", async () => {
    expect(await describeClaudeCodeLogin({ binaryPath: fakeClaude("not json") })).toBe(
      "Claude: couldn't check the Claude Code login",
    )
    expect(await describeClaudeCodeLogin({ binaryPath: undefined })).toMatch(/checked once Claude has been downloaded/)
  })
})
