import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { describeClaudeCodeLogin, signInToClaudeCode } from "./claudeCodeLogin.ts"

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

// A stand-in for a `claude` that is signed in once the file `signed-in` is next to it. `loginBody` is what
// `claude auth login --claudeai` does.
function statefulClaude(args: { signedIn: boolean; loginBody: string }): { binaryPath: string; dir: string } {
  const binaryPath = fakeClaude(
    [
      'dir=$(dirname "$0")',
      'if [ "$1 $2" = "auth status" ]; then',
      '  if [ -f "$dir/signed-in" ]; then echo \'{"loggedIn": true}\'; else echo \'{"loggedIn": false}\'; exit 1; fi',
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "auth login" ]; then',
      '  touch "$dir/login-ran"',
      `  ${args.loginBody}`,
      "  exit $?",
      "fi",
      "exit 2",
    ].join("\n"),
  )
  const dir = dirname(binaryPath)
  if (args.signedIn) writeFileSync(join(dir, "signed-in"), "")
  return { binaryPath, dir }
}

describe("signInToClaudeCode", () => {
  it("leaves a Claude Code that is signed in alone", async () => {
    const { binaryPath, dir } = statefulClaude({ signedIn: true, loginBody: "true" })

    expect(await signInToClaudeCode({ binaryPath })).toEqual({ status: "already_signed_in" })
    expect(existsSync(join(dir, "login-ran"))).toBe(false)
  })

  it("signs in with the Claude subscription when nobody is", async () => {
    const { binaryPath } = statefulClaude({
      signedIn: false,
      loginBody: '[ "$3" = "--claudeai" ] && touch "$dir/signed-in"',
    })

    expect(await signInToClaudeCode({ binaryPath })).toEqual({ status: "signed_in" })
  })

  it("fails when the login fails, without repeating its output (it holds the authorization URL)", async () => {
    const { binaryPath } = statefulClaude({
      signedIn: false,
      loginBody: "echo https://claude.ai/oauth/authorize?state=secret-state; exit 1",
    })

    const result = await signInToClaudeCode({ binaryPath })

    expect(result.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain("secret-state")
  })

  it("doesn't trust a login that says it worked but left nobody signed in", async () => {
    const { binaryPath } = statefulClaude({ signedIn: false, loginBody: "true" })

    expect(await signInToClaudeCode({ binaryPath })).toMatchObject({ status: "failed" })
  })

  it("stops the login when the daemon shuts down", async () => {
    const { binaryPath, dir } = statefulClaude({ signedIn: false, loginBody: "sleep 30" })
    const controller = new AbortController()

    const outcome = signInToClaudeCode({ binaryPath, signal: controller.signal })
    // The login is the process waiting for the browser: abort once it started.
    await vi.waitFor(() => expect(existsSync(join(dir, "login-ran"))).toBe(true))
    controller.abort()

    expect(await outcome).toMatchObject({ status: "failed" })
  })
})
