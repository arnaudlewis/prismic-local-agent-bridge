import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { createApiKeyVault } from "../../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../../testing/memorySecretStore.ts"
import { AgentAuthError } from "../provider.ts"
import { apiKeyMissingNotice, createClaudeProvider } from "./claudeProvider.ts"
import { blockedCommands, commandNameCandidates, hiddenCommands, nativeCommandName } from "./commands.ts"
import { identifyToolCall, readToolResult } from "./toolCalls.ts"

const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"

function create(args: { stored?: string; env?: string; userClaudeHome?: string; backend?: "keychain" | "file"; agentBin?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-claude-"))
  const store = createMemorySecretStore(args.stored, args.backend)
  const vault = createApiKeyVault({ store, env: () => args.env })
  const provider = createClaudeProvider({ dataDir, vault, userClaudeHome: args.userClaudeHome, agentBin: args.agentBin })
  return { dataDir, store, vault, provider }
}

describe("claude provider", () => {
  it("identifies itself and starts every new session in the mode that asks", () => {
    const { provider } = create()

    expect(provider.id).toBe("claude")
    expect(provider.label).toBe("Claude")
    expect(provider.initialConfig?.()).toEqual({ mode: "default" })
    expect(provider.protectedConfigIds).toEqual(["mode"])
  })

  describe("authenticate", () => {
    it("hands the key to the child through its environment, with a fingerprint that isn't the key", async () => {
      const { provider } = create({ stored: key })

      const credentials = await provider.authenticate()

      expect(credentials.env).toEqual({ ANTHROPIC_API_KEY: key })
      expect(credentials.fingerprint).toMatch(/^[0-9a-f]{16}$/)
      expect(credentials.fingerprint).not.toContain(key.slice(-8))
    })

    it("asks for a key when there is none, with the notice the browser shows", async () => {
      const { provider } = create()

      const error = await provider.authenticate().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AgentAuthError)
      expect((error as AgentAuthError).notice).toBe("Add your Anthropic API key to use Claude.")
      expect(apiKeyMissingNotice).toBe("Add your Anthropic API key to use Claude.")
    })

    it("uses ANTHROPIC_API_KEY from the daemon's environment when there is one", async () => {
      const envKey = "sk-ant-api03-FROMTHEENVIRONMENT9999"
      const { provider } = create({ stored: key, env: envKey })

      expect((await provider.authenticate()).env).toEqual({ ANTHROPIC_API_KEY: envKey })
    })

    it("changes its fingerprint when the key is replaced and when it comes back after a removal", async () => {
      const { provider, vault } = create({ stored: key })
      const first = (await provider.authenticate()).fingerprint

      await vault.set("sk-ant-api03-ANOTHERKEYANOTHERKEY5678")
      const second = (await provider.authenticate()).fingerprint

      expect(second).not.toBe(first)
      await vault.set(key)
      expect((await provider.authenticate()).fingerprint).toBe(first)
    })
  })

  describe("spawnSpec", () => {
    it("runs claude-agent-acp with --hide-claude-auth, an isolated private config dir and no inherited credentials", () => {
      const { provider, dataDir } = create()

      const spec = provider.spawnSpec({ projectDir: "/tmp" })

      expect(spec.command).toBe(process.execPath)
      expect(spec.args).toHaveLength(2)
      expect(spec.args[0]).toMatch(/claude-agent-acp/)
      expect(spec.args[1]).toBe("--hide-claude-auth")
      expect(spec.env).toEqual({
        CLAUDE_CONFIG_DIR: join(dataDir, "claude-home"),
        NO_BROWSER: "1",
        DISABLE_AUTOUPDATER: "1",
      })
      expect(statSync(join(dataDir, "claude-home")).mode & 0o777).toBe(0o700)
    })

    it("never puts the key on the command line or in the spec's own environment", async () => {
      const { provider } = create({ stored: key })

      const spec = provider.spawnSpec({ projectDir: "/tmp" })

      expect(JSON.stringify(spec)).not.toContain(key)
      expect(spec.env).not.toHaveProperty("ANTHROPIC_API_KEY")
    })

    it("uses the user's Claude config dir as is with --use-user-claude, and creates no isolated one", () => {
      const userHome = mkdtempSync(join(tmpdir(), "bridge-user-claude-"))
      mkdirSync(join(userHome, "skills"))
      const { provider, dataDir } = create({ userClaudeHome: userHome })

      const spec = provider.spawnSpec({ projectDir: "/tmp" })

      expect(spec.env.CLAUDE_CONFIG_DIR).toBe(userHome)
      expect(spec.args[1]).toBe("--hide-claude-auth")
      expect(existsSync(join(dataDir, "claude-home"))).toBe(false)
    })

    it("overrides the entry point (tests only)", () => {
      expect(create({ agentBin: "/fake/agent.ts" }).provider.spawnSpec({ projectDir: "/tmp" }).args[0]).toBe("/fake/agent.ts")
    })
  })

  describe("status", () => {
    it("reports a missing key with where it would be kept", async () => {
      expect((await create().provider.getStatus()).account).toEqual({ kind: "apiKey", status: "missing", storage: "keychain" })
      expect((await create({ backend: "file" }).provider.getStatus()).account).toEqual({
        kind: "apiKey",
        status: "missing",
        storage: "file",
      })
    })

    it("reports a configured key as a hint, never the key", async () => {
      const status = await create({ stored: key }).provider.getStatus()

      expect(status).toEqual({ account: { kind: "apiKey", status: "configured", keyHint: "…1234", storage: "keychain" } })
      expect(JSON.stringify(status)).not.toContain(key)
    })

    it("reports a key from the environment as such", async () => {
      expect((await create({ env: "sk-ant-api03-FROMTHEENVIRONMENT9999" }).provider.getStatus()).account).toEqual({
        kind: "apiKey",
        status: "configured",
        keyHint: "…9999",
        storage: "env",
      })
    })

    it("has no daemon-wide mode or model", async () => {
      const status = await create({ stored: key }).provider.getStatus()

      expect(status).not.toHaveProperty("agentMode")
      expect(status).not.toHaveProperty("model")
    })
  })

  describe("banner", () => {
    it("tells where the key is and which config dir is used, without the key", async () => {
      const { provider, dataDir } = create({ stored: key })

      const lines = await provider.bannerLines()

      expect(lines).toEqual([
        "Claude: Anthropic API key configured (keychain, …1234)",
        `Claude config: ${join(dataDir, "claude-home")} (isolated)`,
      ])
      expect(lines.join("\n")).not.toContain(key)
    })

    it("says when there is no key yet and warns about the file fallback", async () => {
      expect((await create().provider.bannerLines())[0]).toBe("Claude: no Anthropic API key yet (it will be kept in the OS keychain)")
      expect((await create({ backend: "file" }).provider.bannerLines())[0]).toContain("a private file, there is no OS keychain")
    })

    it("says the user's config dir is used for everything but the login", async () => {
      expect((await create({ userClaudeHome: "/home/me/.claude" }).provider.bannerLines())[1]).toBe(
        "Claude config: /home/me/.claude (user, API key only: its login is never used)",
      )
    })
  })

  describe("prompt errors", () => {
    it.each([
      new Error("Authentication required"),
      new Error("401 invalid x-api-key"),
      new Error('{"type":"authentication_error"}'),
    ])("explains a rejected key (%s)", (error) => {
      expect(create().provider.describePromptError?.(error)).toBe(
        "Anthropic rejected the API key. Check it in the Claude settings, or replace it.",
      )
    })

    it("explains an account without credit", () => {
      expect(create().provider.describePromptError?.(new Error("Your credit balance is too low to access the API"))).toBe(
        "Your Anthropic account has no credit left. Add credit in the Anthropic console.",
      )
    })

    it("leaves others to the generic message", () => {
      expect(create().provider.describePromptError?.(new Error("something else"))).toBeUndefined()
    })
  })

  it("tells the model how the Prismic MCP tools are named for Claude", () => {
    const additions = create().provider.preambleAdditions?.() ?? []

    expect(additions.join("\n")).toContain("mcp__prismic__<tool>")
  })

  it("registers the key routes", () => {
    expect(create().provider.routes?.().map(({ method, path, auth }) => ({ method, path, auth }))).toEqual([
      { method: "PUT", path: "/auth/claude/key", auth: "bearer" },
      { method: "DELETE", path: "/auth/claude/key", auth: "bearer" },
    ])
  })
})

describe("claude commands", () => {
  it.each(["login", "logout", "config", "permissions", "update-config", "fewer-permission-prompts", "auto-mode-setup", "goal", "loop", "add-dir", "agents", "plugin", "reload-plugins", "design-consent", "clear", "resume"])(
    "blocks /%s",
    (name) => {
      expect(blockedCommands).toContain(name)
    },
  )

  it.each(["context", "compact", "init", "mcp", "debug", "code-review", "simplify", "security-review", "usage"])(
    "does not block /%s",
    (name) => {
      expect(blockedCommands).not.toContain(name)
    },
  )

  it("hides the commands that have a control in the browser, without blocking them", () => {
    expect(hiddenCommands).toEqual(["model", "effort", "fast"])
    for (const name of hiddenCommands) expect(blockedCommands).not.toContain(name)
  })

  describe("nativeCommandName follows claude-agent-acp's own reading", () => {
    it.each([
      ["/context", "context"],
      ["/context\n", "context"],
      ["/compact now please", "compact"],
      ["/CONTEXT", "context"],
      ["/mcp:server:cmd args", "mcp:server:cmd"],
    ])("reads %j as the command %j", (text, name) => {
      expect(nativeCommandName(text)).toBe(name)
    })

    it.each([" /context", "\n/context", "/ context", "/\tcontext", "\ufeff/context", "/", "hello", "what is /context", ""])(
      "does not read %j as a command",
      (text) => {
        expect(nativeCommandName(text)).toBeUndefined()
      },
    )
  })

  describe("commandNameCandidates over-reads on purpose", () => {
    it.each([
      ["/logout", ["logout"]],
      ["/ logout", ["logout"]],
      [" /LOGOUT now", ["logout"]],
      ["\n\t/\u00a0goal", ["goal"]],
      ["\ufeff/update-config", ["update-config"]],
      ["/\u200bloop", ["\u200bloop", "loop"]],
      ["hello /logout", []],
    ])("reads %j as %j", (text, names) => {
      expect(commandNameCandidates(text)).toEqual(names)
    })

    it("catches every blocked command under every odd reading", () => {
      for (const name of blockedCommands) {
        for (const text of [`/${name}`, `/ ${name}`, ` /${name}`, `/\t${name}`, `\u00a0/\u00a0${name.toUpperCase()}`, `\ufeff/${name} x`]) {
          expect(commandNameCandidates(text)).toContain(name)
        }
      }
    })
  })
})

describe("claude tool calls", () => {
  it("identifies an MCP call by its name, its title or the name in _meta", () => {
    const identity = { server: "prismic", tool: "get_editor_context" }

    expect(identifyToolCall({ toolCallId: "t", name: "mcp__prismic__get_editor_context" })).toEqual(identity)
    expect(identifyToolCall({ toolCallId: "t", title: "mcp__prismic__get_editor_context" })).toEqual(identity)
    expect(identifyToolCall({ toolCallId: "t", _meta: { claudeCode: { toolName: "mcp__prismic__get_editor_context" } } })).toEqual(identity)
  })

  it("keeps an underscore in the server or tool name", () => {
    expect(identifyToolCall({ toolCallId: "t", name: "mcp__my_server__do_it" })).toEqual({ server: "my_server", tool: "do_it" })
  })

  it("does not take a built-in tool for an MCP one", () => {
    expect(identifyToolCall({ toolCallId: "t", name: "Bash", title: "Run command" })).toBeUndefined()
    expect(identifyToolCall({ toolCallId: "t", title: "mcp__incomplete" })).toBeUndefined()
  })

  it("reads the tool result from content blocks, or from the bare rawOutput blocks or text", () => {
    const payload = { status: "no_pin" }
    const text = JSON.stringify(payload)

    expect(readToolResult({ toolCallId: "t", content: [{ type: "content", content: { type: "text", text } }] })).toEqual(payload)
    expect(readToolResult({ toolCallId: "t", rawOutput: [{ type: "text", text }] })).toEqual(payload)
    expect(readToolResult({ toolCallId: "t", rawOutput: text })).toEqual(payload)
    expect(readToolResult({ toolCallId: "t", content: [{ type: "content", content: { type: "text", text: "not json" } }] })).toBeUndefined()
  })
})
