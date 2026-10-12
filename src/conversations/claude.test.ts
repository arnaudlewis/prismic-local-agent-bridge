import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import type { BridgeEvent } from "../protocol.ts"
import { chatHistory, createHarness, editorContextEvents, fakeAgentBin, lastStatus, liveAgentText, notices, promptedBlocks, session, windowA, windowB } from "../testing/harness.ts"

const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
const claudeSession = { ...session, agent: "claude" as const }
const claudeChannel = `${windowA}/claude`

// The fake agent stands in for claude-agent-acp: it starts in "bypassPermissions" (what a user's own settings may say)
// and offers Claude's modes and commands.
beforeEach(() => {
  process.env.FAKE_AGENT_MODE_VALUES = "bypassPermissions,default,acceptEdits,plan,auto"
  process.env.FAKE_AGENT_COMMANDS = "context,compact,init,mcp,login,logout,config,update-config,model,effort,fast,goal,loop,clear,agents"
  process.env.ANTHROPIC_BASE_URL = "https://inherited.example"
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-oauth-token"
})

afterEach(() => {
  for (const name of ["FAKE_AGENT_MODE_VALUES", "FAKE_AGENT_COMMANDS", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    delete process.env[name]
  }
})

function createClaudeHarness(args: { stored?: string } = { stored: key }) {
  const store = createMemorySecretStore(args.stored)
  const vault = createApiKeyVault({ store, env: () => undefined })
  let provider: ReturnType<typeof createClaudeProvider> | undefined
  const harness = createHarness({
    providers: (() => {
      // The dataDir is only known once the harness exists: the provider gets a throwaway one, which is all the fake needs.
      provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault, userClaudeHome: "/tmp", agentBin: fakeAgentBin })
      return [provider]
    })(),
  })
  return { harness, vault, store, provider: provider as ReturnType<typeof createClaudeProvider> }
}

function modeOf(events: BridgeEvent[]): string | undefined {
  const config = events.findLast((event) => event.type === "session_config")
  return config?.type === "session_config" ? config.options.find((option) => option.id === "mode")?.currentValue : undefined
}

function commandNames(events: BridgeEvent[]): string[] {
  const list = events.findLast((event) => event.type === "available_commands")
  return list?.type === "available_commands" ? list.commands.map((command) => command.name) : []
}

function prompted(events: BridgeEvent[]): string[] {
  return promptedBlocks(events)
}

describe("a conversation with the Claude agent", () => {
  it("starts in the mode that asks, whatever the agent's own settings start it in", async () => {
    const { harness } = createClaudeHarness()

    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(notices(harness.events)).toEqual([])
    expect(modeOf(harness.events)).toBe("default")
  })

  it("does not start an agent that can't be put in that mode", async () => {
    process.env.FAKE_AGENT_MODE_VALUES = "bypassPermissions,plan"
    const { harness } = createClaudeHarness()

    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(notices(harness.events)).toEqual(["Couldn't start the local agent: The agent doesn't offer mode = default"])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(lastStatus(harness.events)).toBe("idle")
  })

  it("ignores a mode asked for in preferredConfig, and only changes it on an explicit request", async () => {
    const { harness } = createClaudeHarness()

    await harness.agents.handleMessage(claudeChannel, {
      type: "chat_open",
      session: claudeSession,
      preferredConfig: { mode: "bypassPermissions" },
    })
    expect(modeOf(harness.events)).toBe("default")

    await harness.agents.handleMessage(claudeChannel, { type: "set_config_option", configId: "mode", value: "acceptEdits" })
    expect(modeOf(harness.events)).toBe("acceptEdits")
  })

  it("keeps the mode the user chose across a restart of the agent, instead of resetting it", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "hello", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "set_config_option", configId: "mode", value: "plan" })

    await harness.agents.handleMessage(`${windowB}/claude`, { type: "chat_open", session: claudeSession })

    expect(modeOf(harness.events)).toBe("plan")
  })

  it("offers the commands without the blocked and the hidden ones", async () => {
    const { harness } = createClaudeHarness()

    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(commandNames(harness.events)).toEqual(["context", "compact", "init", "mcp"])
  })

  it.each(["/login", "/logout", "/ logout", " /config", "/\tgoal now", "/UPDATE-CONFIG", "\u00a0/loop", "/clear", "/agents"])(
    "does not forward %j",
    async (text) => {
      const { harness } = createClaudeHarness()
      await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
      harness.events.length = 0

      await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text, session: claudeSession })

      expect(prompted(harness.events)).toEqual([])
      expect(notices(harness.events)).toHaveLength(1)
      expect(notices(harness.events)[0]).toMatch(/^The \/[\w-]+ command isn't available in the local agent\.$/)
      expect(lastStatus(harness.events)).toBe("idle")
    },
  )

  it.each(["/context", "/compact now", "/model", "/effort high"])("forwards the command %j without a preamble", async (text) => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    harness.events.length = 0

    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text, session: claudeSession })

    expect(notices(harness.events)).toEqual([])
    expect(prompted(harness.events)).toEqual([text])
  })

  it("treats what Claude doesn't read as a command as a regular prompt, with the preamble", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    harness.events.length = 0

    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "/ context", session: claudeSession })

    expect(prompted(harness.events)).toHaveLength(2)
    expect(prompted(harness.events)[0]).toContain("mcp__prismic__<tool>")
    expect(prompted(harness.events)[1]).toBe("/ context")
  })

  it("catches the editor context from the way Claude reports an MCP call, once", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    const payload = { status: "no_pin", ambiguous: false, detected: { document: { id: "D1", title: "Home", uid: "home" } } }

    await harness.agents.handleMessage(claudeChannel, {
      type: "chat_prompt",
      text: `emit-claude-tool prismic get_editor_context ${JSON.stringify(payload)}`,
      session: claudeSession,
    })
    await harness.agents.handleMessage(claudeChannel, {
      type: "chat_prompt",
      text: `emit-claude-tool prismic get_editor_context ${JSON.stringify(payload)}`,
      session: claudeSession,
    })

    const cards = editorContextEvents(harness.events)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ context: { status: "no_pin", document: { id: "D1", uid: "home", title: "Home" } } })
  })

  it("ignores another MCP server's tool of the same name", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    await harness.agents.handleMessage(claudeChannel, {
      type: "chat_prompt",
      text: 'emit-claude-tool other get_editor_context {"status":"no_pin","ambiguous":false}',
      session: claudeSession,
    })

    expect(editorContextEvents(harness.events)).toEqual([])
  })

  it("persists and lists the conversation as a claude one, apart from the codex ones", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "a claude thread", session: claudeSession })

    await harness.agents.handleMessage(claudeChannel, { type: "threads_list", repository: "repo", agent: "claude" })

    const threads = harness.events.findLast((event) => event.type === "threads")
    expect(threads?.type === "threads" && threads.threads.map((thread) => thread.title)).toEqual(["a claude thread"])
    const second = createHarness({ dataDir: harness.dataDir })
    const codexSession = { ...session, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    await second.agents.handleMessage(`${windowA}/codex`, { type: "chat_open", session: codexSession })
    await second.agents.handleMessage(`${windowA}/codex`, { type: "threads_list", repository: "repo", agent: "codex" })
    expect(second.events.findLast((event) => event.type === "threads")).toEqual({ type: "threads", threads: [] })
  })

  it("replays the history of a claude conversation after a restart", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "remember me", session: claudeSession })
    harness.agents.stopAll()

    const store = createMemorySecretStore(key)
    const provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault: createApiKeyVault({ store, env: () => undefined }), userClaudeHome: "/tmp", agentBin: fakeAgentBin })
    const restarted = createHarness({ dataDir: harness.dataDir, providers: [provider] })
    await restarted.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(chatHistory(restarted.eventsFor(claudeChannel))[0]).toEqual({ type: "user_message", text: "remember me" })
    expect(notices(restarted.events)).toEqual([])
    await restarted.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "again", session: claudeSession })
    expect(liveAgentText(restarted.events)).toContain("ctx:load")
  })
})

describe("the API key behind a conversation", () => {
  it("asks for the key, with the browser's notice, when there is none, and starts no agent", async () => {
    const { harness } = createClaudeHarness({})

    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(lastStatus(harness.events)).toBe("idle")
  })

  it("starts once the key is added, without restarting the daemon", async () => {
    const { harness, vault } = createClaudeHarness({})
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    harness.events.length = 0

    await vault.set(key)
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })

    expect(notices(harness.events)).toEqual([])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(true)
  })

  it("passes the key to the agent through its environment, and not the daemon's own credentials or endpoint", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    harness.events.length = 0

    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "NO_BROWSER"]) {
      await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: `${name === "ANTHROPIC_API_KEY" ? "env-tail" : "echo-env"} ${name}`, session: claudeSession })
    }

    const text = liveAgentText(harness.events)
    expect(text).toContain(`envtail:ANTHROPIC_API_KEY=${key.slice(-4)}`)
    // The agent echoes each variable right after the previous one: an empty value is followed by the next echo.
    expect(text).toContain("env:ANTHROPIC_BASE_URL=env:CLAUDE_CODE_OAUTH_TOKEN=env:CLAUDE_CONFIG_DIR=")
    expect(text).not.toContain("inherited")
    expect(text).toContain("env:CLAUDE_CONFIG_DIR=/tmp")
    expect(text).toContain("env:NO_BROWSER=1")
  })

  it("never writes the key to the transcript, the conversation file or the notices", async () => {
    const { harness } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "hello", session: claudeSession })
    await vi.waitFor(() => expect(JSON.stringify(chatHistory(harness.events))).toBeDefined())
    harness.agents.stopAll()

    const { readFileSync, readdirSync } = await import("node:fs")
    const dir = `${harness.dataDir}/conversations`
    const stored = readdirSync(dir).map((name) => readFileSync(`${dir}/${name}`, "utf8")).join("\n")
    expect(stored).not.toContain(key)
    expect(JSON.stringify(harness.events)).not.toContain(key)
  })

  it("restarts the agent, resuming the conversation, when the key is replaced, and not while a turn runs", async () => {
    const { harness, vault } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "first", session: claudeSession })

    await vault.set("sk-ant-api03-REPLACEDREPLACEDREPLACED7777")
    harness.events.length = 0
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "env-tail ANTHROPIC_API_KEY", session: claudeSession })

    expect(notices(harness.events)).toEqual([])
    expect(liveAgentText(harness.events)).toContain("envtail:ANTHROPIC_API_KEY=7777")
    expect(liveAgentText(harness.events)).not.toContain(key.slice(-4))
  })

  it("does not restart a running turn when the key is replaced", async () => {
    const { harness, vault } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    const turn = harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "hold on", session: claudeSession })
    await vi.waitFor(() => expect(liveAgentText(harness.events)).toContain("working"))

    await vault.set("sk-ant-api03-REPLACEDREPLACEDREPLACED7777")
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    expect(lastStatus(harness.events)).toBe("running")

    await harness.agents.handleMessage(claudeChannel, { type: "chat_cancel" })
    await turn
    expect(harness.events).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
  })

  it("stops the running agent at once when the key is removed: turn cancelled, approvals denied, window idle", async () => {
    const { harness, provider } = createClaudeHarness()
    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    const turn = harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "ask-permission", session: claudeSession })
    await vi.waitFor(() => expect(harness.events.some((event) => event.type === "permission_request")).toBe(true))
    harness.events.length = 0

    // The DELETE route's effect: the vault is emptied and the provider announces it.
    const route = provider.routes?.().find((candidate) => candidate.method === "DELETE")
    await route?.handle({ req: {} as never, res: { writeHead: () => {}, end: () => {} } as never, url: new URL("http://x/"), paired: undefined })
    await turn

    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(lastStatus(harness.events)).toBe("idle")
    expect(harness.events.some((event) => event.type === "turn_end")).toBe(false)

    harness.events.length = 0
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "hello again", session: claudeSession })
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(prompted(harness.events)).toEqual([])
  })

  it("does not touch the Codex conversations when the Claude key is removed", async () => {
    const store = createMemorySecretStore(key)
    const provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault: createApiKeyVault({ store, env: () => undefined }), userClaudeHome: "/tmp", agentBin: fakeAgentBin })
    const harness = createHarness({ providerOverrides: {} })
    await harness.agents.handleMessage(`${windowA}/codex`, { type: "chat_open", session })
    harness.events.length = 0

    await provider.routes?.().find((candidate) => candidate.method === "DELETE")?.handle({
      req: {} as never,
      res: { writeHead: () => {}, end: () => {} } as never,
      url: new URL("http://x/"),
      paired: undefined,
    })

    expect(harness.events).toEqual([])
    await harness.agents.handleMessage(`${windowA}/codex`, { type: "chat_prompt", text: "still works", session })
    expect(liveAgentText(harness.events)).toContain("prompt:still works")
  })
})
