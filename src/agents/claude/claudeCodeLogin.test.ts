import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { describeClaudeCodeLogin } from "./claudeCodeLogin.ts"

// A stand-in for `claude`: a shell script with the given body.
function fakeClaude(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "bridge-claude-login-")), "claude")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("describeClaudeCodeLogin", () => {
  it("names the account and the subscription of a signed-in Claude Code", async () => {
    const binaryPath = fakeClaude(`echo '{"loggedIn": true, "email": "me@example.com", "subscriptionType": "max"}'`)

    expect(await describeClaudeCodeLogin({ binaryPath })).toBe("Claude: me@example.com (max)")
  })

  it("says Claude Code isn't signed in, although `claude auth status` exits with 1 then", async () => {
    const binaryPath = fakeClaude(`echo '{"loggedIn": false, "authMethod": "none"}'\nexit 1`)

    expect(await describeClaudeCodeLogin({ binaryPath })).toBe("Claude: Claude Code isn't signed in")
  })

  it("asks about the config directory the agent runs with", async () => {
    const binaryPath = fakeClaude(`echo "{\\"loggedIn\\": true, \\"email\\": \\"$CLAUDE_CONFIG_DIR\\"}"`)

    expect(await describeClaudeCodeLogin({ binaryPath, configDir: "/tmp/claude-elsewhere" })).toBe(
      "Claude: /tmp/claude-elsewhere",
    )
  })

  it("doesn't pretend to know when the answer can't be read or the binary isn't there yet", async () => {
    expect(await describeClaudeCodeLogin({ binaryPath: fakeClaude("echo not json") })).toBe(
      "Claude: couldn't check the Claude Code login",
    )
    expect(await describeClaudeCodeLogin({ binaryPath: undefined })).toMatch(/checked once Claude has been downloaded/)
  })

  it("stops the probe when the daemon shuts down", async () => {
    const binaryPath = fakeClaude("sleep 30")
    const controller = new AbortController()

    const description = describeClaudeCodeLogin({ binaryPath, signal: controller.signal })
    controller.abort()

    expect(await description).toBe("Claude: couldn't check the Claude Code login")
  })
})
