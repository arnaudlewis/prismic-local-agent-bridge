import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { AgentAuthError } from "../provider.ts"
import { ChatGptAuthError } from "./chatgptAuth.ts"
import type { ChatGptAuth } from "./chatgptAuth.ts"
import { createCodexProvider } from "./codexProvider.ts"
import type { CodexProviderArgs } from "./codexProvider.ts"

function fakeAuth(overrides: Partial<ChatGptAuth> = {}): ChatGptAuth {
  return {
    getStatus: () => ({ status: "signed_in", email: "me@example.com", planUsage: true }),
    startSignIn: () => "https://auth.example/authorize",
    handleCallback: () => Promise.resolve({ ok: true, message: "Signed in" }),
    getAccessToken: () => Promise.resolve({ accessToken: "access-token", expiresAt: 1234 }),
    signOut: () => Promise.resolve(),
    ...overrides,
  }
}

function createProvider(overrides: Partial<CodexProviderArgs> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-codex-"))
  return {
    dataDir,
    provider: createCodexProvider({
      dataDir,
      auth: fakeAuth(),
      userCodexHome: undefined,
      agentMode: "read-only",
      model: undefined,
      refreshMarginMs: 1000,
      ...overrides,
    }),
  }
}

describe("codex provider", () => {
  it("identifies itself and declares its command policy", () => {
    const { provider } = createProvider()

    expect(provider.id).toBe("codex")
    expect(provider.label).toBe("Codex")
    expect(provider.blockedCommands).toEqual(["logout", "review", "review-branch", "review-commit", "goal"])
    expect(provider.hiddenCommands).toEqual(["plan"])
    expect(provider.protectedConfigIds).toEqual(["mode"])
  })

  describe("authenticate", () => {
    it("returns the access token for the child and a fingerprint that changes with it", async () => {
      const getAccessToken = vi.fn().mockResolvedValue({ accessToken: "access-token", expiresAt: 1234 })
      const { provider } = createProvider({ auth: fakeAuth({ getAccessToken }), refreshMarginMs: 777 })

      expect(await provider.authenticate()).toEqual({ fingerprint: "1234", env: { ACCESS_TOKEN: "access-token" } })
      expect(getAccessToken).toHaveBeenCalledWith(777)
    })

    it.each([
      ["signed_out", "Sign in with ChatGPT to use the local agent."],
      [
        "plan_usage_disabled",
        "ChatGPT plan use isn't enabled for Prismic Local Agent. Use Continue with ChatGPT again to enable it.",
      ],
      ["refresh_failed", "Couldn't refresh the ChatGPT session. Try again in a moment."],
    ] as const)("turns the %s error into a user-facing notice", async (code, notice) => {
      const { provider } = createProvider({
        auth: fakeAuth({ getAccessToken: () => Promise.reject(new ChatGptAuthError(code, "details")) }),
      })

      const error = await provider.authenticate().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AgentAuthError)
      expect((error as AgentAuthError).notice).toBe(notice)
    })

    it("lets other errors through", async () => {
      const { provider } = createProvider({ auth: fakeAuth({ getAccessToken: () => Promise.reject(new Error("boom")) }) })

      await expect(provider.authenticate()).rejects.toThrow("boom")
    })
  })

  describe("spawnSpec", () => {
    it("runs codex-acp with an isolated Codex home it writes, billed through the ChatGPT plan provider", () => {
      const { provider, dataDir } = createProvider({ model: "gpt-x" })

      const spec = provider.spawnSpec({ projectDir: "/tmp" })

      expect(spec.command).toBe(process.execPath)
      expect(spec.args).toHaveLength(1)
      expect(spec.args[0]).toMatch(/codex-acp/)
      expect(spec.env).toEqual({
        CODEX_HOME: join(dataDir, "codex-home"),
        MODEL_PROVIDER: "openai_chatgpt_plan",
        INITIAL_AGENT_MODE: "read-only",
        NO_BROWSER: "1",
      })
      const config = readFileSync(join(dataDir, "codex-home", "config.toml"), "utf8")
      expect(config).toContain('model = "gpt-x"')
      expect(config).toContain('model_provider = "openai_chatgpt_plan"')
    })

    it("uses the user's Codex home as is, and injects the provider through CODEX_CONFIG", () => {
      const userHome = mkdtempSync(join(tmpdir(), "bridge-user-codex-"))
      const { provider, dataDir } = createProvider({ userCodexHome: userHome, model: "gpt-x", agentMode: "agent" })

      const spec = provider.spawnSpec({ projectDir: "/tmp" })

      expect(spec.env.CODEX_HOME).toBe(userHome)
      expect(spec.env.INITIAL_AGENT_MODE).toBe("agent")
      expect(JSON.parse(spec.env.CODEX_CONFIG ?? "{}")).toMatchObject({
        model_provider: "openai_chatgpt_plan",
        model: "gpt-x",
        model_providers: { openai_chatgpt_plan: { env_key: "ACCESS_TOKEN" } },
      })
      expect(existsSync(join(userHome, "config.toml"))).toBe(false)
      expect(existsSync(join(dataDir, "codex-home"))).toBe(false)
    })

    it("overrides the entry point (tests only)", () => {
      const { provider } = createProvider({ agentBin: "/fake/agent.ts" })

      expect(provider.spawnSpec({ projectDir: "/tmp" }).args).toEqual(["/fake/agent.ts"])
    })
  })

  it("recognizes codex-acp's native commands, but not $skill", () => {
    const { provider } = createProvider()

    expect(provider.nativeCommandName("/ Logout now")).toBe("logout")
    expect(provider.nativeCommandName("/$skill")).toBeUndefined()
    expect(provider.nativeCommandName("hello")).toBeUndefined()
  })

  it("reads MCP tool calls the way codex-acp reports them", () => {
    const { provider } = createProvider()

    expect(provider.identifyToolCall({ toolCallId: "t", title: "mcp.prismic.get_editor_context" })).toEqual({
      server: "prismic",
      tool: "get_editor_context",
    })
    expect(
      provider.identifyToolCall({ toolCallId: "t", rawInput: { server: "prismic", tool: "get_document", arguments: {} } }),
    ).toEqual({ server: "prismic", tool: "get_document" })
    expect(provider.identifyToolCall({ toolCallId: "t", title: "Run command" })).toBeUndefined()
    expect(
      provider.readToolResult({
        toolCallId: "t",
        rawOutput: { result: { content: [{ type: "text", text: '{"status":"no_pin"}' }] }, error: null },
      }),
    ).toEqual({ status: "no_pin" })
  })

  it("explains a usage limit error and leaves others to the generic message", () => {
    const { provider } = createProvider()

    expect(provider.describePromptError?.(new Error("x subscription_sharing_usage_limit_exceeded y"))).toBe(
      "ChatGPT plan usage limit reached. Manage usage: https://chatgpt.com/settings/usage",
    )
    expect(provider.describePromptError?.(Object.assign(new Error("x"), { data: "subscription_sharing_usage_limit_exceeded" }))).toContain(
      "usage limit reached",
    )
    expect(provider.describePromptError?.(new Error("something else"))).toBeUndefined()
  })

  it("reports its status for GET /status", () => {
    const { provider } = createProvider({ model: "gpt-x", agentMode: "workspace-write" })

    expect(provider.getStatus()).toEqual({
      agentMode: "workspace-write",
      model: "gpt-x",
      account: { kind: "chatgpt", status: "signed_in", email: "me@example.com", planUsage: true },
    })
    expect(createProvider().provider.getStatus()).not.toHaveProperty("model")
  })

  it("prints its banner lines", () => {
    const { provider, dataDir } = createProvider({ model: "gpt-x" })

    expect(provider.bannerLines()).toEqual([
      "Agent mode: read-only, model: gpt-x",
      `Codex home: ${join(dataDir, "codex-home")} (isolated)`,
      "ChatGPT: signed_in",
    ])
    expect(createProvider({ userCodexHome: "/home/me/.codex" }).provider.bannerLines()[1]).toBe(
      "Codex home: /home/me/.codex (user)",
    )
  })

  it("registers its sign-in routes", () => {
    const { provider } = createProvider()

    expect(provider.routes?.().map(({ method, path, auth, originExempt }) => ({ method, path, auth, originExempt }))).toEqual([
      { method: "GET", path: "/auth/callback", auth: "none", originExempt: true },
      { method: "POST", path: "/auth/chatgpt/start", auth: "bearer", originExempt: undefined },
      { method: "POST", path: "/auth/chatgpt/sign-out", auth: "bearer", originExempt: undefined },
    ])
  })
})
