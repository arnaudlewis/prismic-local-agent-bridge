import { describe, expect, it } from "vitest"

import { AgentAuthError } from "../agents/provider.ts"
import {
  chatHistory,
  createHarness,
  fakeAgentBin,
  liveAgentText,
  notices,
  session,
  windowId,
} from "../testing/harness.ts"
import type { BridgeEvent } from "../protocol.ts"

// The conversation machinery knows nothing about Codex: everything agent-specific goes through the provider. These
// tests swap parts of the provider and check the machinery follows.
describe("the conversation machinery goes through the provider", () => {
  async function open(harness: ReturnType<typeof createHarness>) {
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    harness.events.length = 0
  }

  function prompted(events: BridgeEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === "agent_message_chunk" && event.text.startsWith("prompt:") ? [event.text.slice(7)] : [],
    )
  }

  it("blocks the commands the provider says are blocked, not Codex's list", async () => {
    const harness = createHarness({
      providerOverrides: {
        blockedCommands: ["status"],
        nativeCommandName: (text) => (text.startsWith("!") ? text.slice(1).split(" ")[0] : undefined),
      },
    })
    await open(harness)

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "!status now", session })
    expect(notices(harness.events)).toEqual(["The /status command isn't available in the local agent."])
    expect(prompted(harness.events)).toEqual([])

    harness.events.length = 0
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "!logout", session })
    expect(notices(harness.events)).toEqual([])
    expect(prompted(harness.events)).toEqual(["!logout"])
  })

  it("treats a prompt as a native command only when the provider says so (no preamble, no context)", async () => {
    const harness = createHarness({ providerOverrides: { nativeCommandName: () => undefined } })
    await open(harness)

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "/status", session })

    // Not native for this provider: the preamble goes before the user's text like for any regular prompt.
    expect(prompted(harness.events)).toHaveLength(2)
    expect(prompted(harness.events)[0]).toContain("You are running inside")
  })

  it("filters the command list with the provider's blocked and hidden commands", async () => {
    const harness = createHarness({ providerOverrides: { blockedCommands: ["mcp"], hiddenCommands: ["status", "logout"] } })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    const list = harness.events.findLast((event) => event.type === "available_commands")
    const names = list?.type === "available_commands" ? list.commands.map((command) => command.name) : []
    expect(names).not.toContain("mcp")
    expect(names).not.toContain("status")
    expect(names).not.toContain("logout")
    // Codex would have hidden "plan" and blocked "review": this provider doesn't.
    expect(names).toContain("plan")
    expect(names).toContain("review")
  })

  it("shows the notice of the provider's AgentAuthError and starts no agent", async () => {
    const harness = createHarness({
      providerOverrides: { authenticate: () => Promise.reject(new AgentAuthError("Log in to Other first.")) },
    })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    expect(notices(harness.events)).toEqual(["Log in to Other first."])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(harness.events.at(-1)).toEqual({ type: "chat_status", status: "idle" })
  })

  it("reports another authenticate() error generically", async () => {
    const harness = createHarness({ providerOverrides: { authenticate: () => Promise.reject(new Error("keychain locked")) } })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    expect(notices(harness.events)).toEqual(["Agent error: keychain locked"])
  })

  it("restarts the agent when the credentials fingerprint changes, and not otherwise", async () => {
    let fingerprint = "one"
    const harness = createHarness({
      providerOverrides: { authenticate: () => Promise.resolve({ fingerprint, env: {} }) },
    })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "first", session })

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "same credentials", session })
    expect(liveAgentText(harness.events).match(/ctx:new/g)).toHaveLength(2)

    fingerprint = "two"
    harness.events.length = 0
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "new credentials", session })
    expect(notices(harness.events)).toEqual([])
    expect(liveAgentText(harness.events)).toContain("ctx:load")
  })

  it("passes the provider's environment and the credentials to the child", async () => {
    const harness = createHarness({
      providerOverrides: {
        authenticate: () => Promise.resolve({ fingerprint: "x", env: { FAKE_AGENT_SECRET: "from-credentials" } }),
      },
    })
    await open(harness)

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "echo-env FAKE_AGENT_SECRET", session })

    expect(liveAgentText(harness.events)).toContain("env:FAKE_AGENT_SECRET=from-credentials")
  })

  it("uses the provider's notice when a stored session can't be resumed", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowId, { type: "chat_open", session })
    await first.agents.handleMessage(windowId, { type: "chat_prompt", text: "hello", session })
    first.agents.stopAll()

    process.env.FAKE_AGENT_FAIL_LOAD = "1"
    try {
      const second = createHarness({ dataDir: first.dataDir, providerOverrides: { sessionRestartedNotice: "Started over." } })
      await second.agents.handleMessage(windowId, { type: "chat_open", session })

      expect(notices(second.events)).toContain("Started over.")
      expect(chatHistory(second.events)[0]).toEqual({ type: "user_message", text: "hello" })
    } finally {
      delete process.env.FAKE_AGENT_FAIL_LOAD
    }
  })

  it("uses the provider's description of a prompt error, else the generic one", async () => {
    const harness = createHarness({
      providerOverrides: { describePromptError: (error) => (String(error).includes("boom") ? "Custom: it blew up." : undefined) },
    })
    await open(harness)

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "fail-prompt boom", session })
    expect(notices(harness.events)).toEqual(["Custom: it blew up."])

    harness.events.length = 0
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "fail-prompt other", session })
    expect(notices(harness.events)).toEqual([expect.stringMatching(/^Agent error: /)])
  })

  it("adds the provider's lines to the preamble", async () => {
    const harness = createHarness({ providerOverrides: { preambleAdditions: () => ["Extra rule from the provider."] } })
    await open(harness)

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "hello", session })

    expect(prompted(harness.events)[0]).toContain("- Extra rule from the provider.")
  })

  it("keeps the config ids the provider protects out of preferredConfig", async () => {
    const harness = createHarness({ providerOverrides: { protectedConfigIds: ["collaboration_mode"] } })

    await harness.agents.handleMessage(windowId, {
      type: "chat_open",
      session,
      preferredConfig: { mode: "agent", collaboration_mode: "plan" },
    })

    const config = harness.events.findLast((event) => event.type === "session_config")
    const options = config?.type === "session_config" ? config.options : []
    expect(options.find((option) => option.id === "mode")?.currentValue).toBe("agent")
    expect(options.find((option) => option.id === "collaboration_mode")?.currentValue).toBe("default")
  })

  it("catches the editor context from the provider's tool call format, not Codex's", async () => {
    const harness = createHarness({
      providerOverrides: {
        identifyToolCall: (update) =>
          update.title === "Prismic/get_editor_context" ? { server: "prismic", tool: "get_editor_context" } : undefined,
        readToolResult: (update) => (update.rawOutput as { json?: unknown } | undefined)?.json,
      },
    })
    await open(harness)

    await harness.agents.handleMessage(windowId, {
      type: "chat_prompt",
      text: 'emit-custom-tool {"status":"no_pin","ambiguous":false,"detected":{"document":{"id":"D1","title":"Home"}}}',
      session,
    })

    const card = harness.events.find((event) => event.type === "editor_context")
    expect(card).toMatchObject({ context: { status: "no_pin", document: { id: "D1", title: "Home" } } })
  })

  it("says so when the conversation's agent has no provider", async () => {
    const harness = createHarness({ providers: [] })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(notices(harness.events)).toEqual(["Agent error: The codex agent isn't available"])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)

    await expect(harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "hi", session })).rejects.toThrow(
      "The codex agent isn't available",
    )
  })

  it("refuses to open a conversation under another agent than the one it belongs to", async () => {
    const harness = createHarness()
    await open(harness)

    await expect(
      harness.agents.handleMessage(windowId, { type: "chat_open", session: { ...session, agent: "other" as never } }),
    ).rejects.toThrow("This conversation belongs to another agent")
  })
})

describe("channels keyed by window and agent", () => {
  const browserWindow = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const codexChannel = `${browserWindow}/codex`

  it("refuses a message for another agent than the one the socket was opened for", async () => {
    const harness = createHarness()

    await harness.agents.handleMessage(codexChannel, { type: "chat_open", session: { ...session, agent: "claude" } })
    await harness.agents.handleMessage(codexChannel, { type: "threads_list", repository: "repo", agent: "claude" })

    expect(notices(harness.events)).toEqual([
      "This connection is for the codex agent, not claude.",
      "This connection is for the codex agent, not claude.",
    ])
    expect(harness.events.some((event) => event.type === "session_config" || event.type === "threads")).toBe(false)
  })

  it("works as before on the matching channel", async () => {
    const harness = createHarness()

    await harness.agents.handleMessage(codexChannel, { type: "chat_open", session })

    expect(notices(harness.events)).toEqual([])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(true)
  })

  it("gives the MCP server the browser's window id in the agent's MCP headers, not the channel key", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(codexChannel, { type: "chat_open", session })

    await harness.agents.handleMessage(codexChannel, { type: "chat_prompt", text: "echo-window", session })

    expect(liveAgentText(harness.events)).toContain(`ctx:new:${browserWindow}`)
    expect(liveAgentText(harness.events)).not.toContain("/codex:")
  })
})

describe("provider hooks the Claude agent needs", () => {
  it("lets a provider read the command more leniently than the agent, and blocks on any reading", async () => {
    const harness = createHarness({
      providerOverrides: {
        blockedCommands: ["logout"],
        nativeCommandName: (text) => (text.startsWith("/") ? text.slice(1).split(/\s/)[0] : undefined),
        commandNameCandidates: (text) => [text.replace(/^\s*\/\s*/, "").split(/\s/)[0] ?? ""],
      },
    })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    harness.events.length = 0

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: " / logout", session })

    expect(notices(harness.events)).toEqual(["The /logout command isn't available in the local agent."])
  })

  it("applies the provider's initial config to a new session only, and starts no agent if it can't be applied", async () => {
    const harness = createHarness({ providerOverrides: { initialConfig: () => ({ mode: "agent" }) } })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    const config = harness.events.findLast((event) => event.type === "session_config")
    expect(config?.type === "session_config" && config.options.find((option) => option.id === "mode")?.currentValue).toBe("agent")

    const refusing = createHarness({ providerOverrides: { initialConfig: () => ({ mode: "no-such-mode" }) } })
    await refusing.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(notices(refusing.events)).toEqual(["Couldn't start the local agent: The agent doesn't offer mode = no-such-mode"])
    expect(refusing.events.some((event) => event.type === "session_config")).toBe(false)
  })

  it("does not pass the variables a provider says the child must not inherit", async () => {
    process.env.FAKE_AGENT_INHERITED = "from-the-daemon"
    process.env.FAKE_AGENT_KEPT = "also-from-the-daemon"
    try {
      const harness = createHarness({
        providerOverrides: {
          spawnSpec: () => ({ command: process.execPath, args: [fakeAgentBin], env: {}, removeEnv: ["FAKE_AGENT_INHERITED"] }),
        },
      })
      await harness.agents.handleMessage(windowId, { type: "chat_open", session })
      harness.events.length = 0

      await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "echo-env FAKE_AGENT_INHERITED", session })
      await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "echo-env FAKE_AGENT_KEPT", session })

      expect(liveAgentText(harness.events)).toBe("env:FAKE_AGENT_INHERITED=env:FAKE_AGENT_KEPT=also-from-the-daemon")
    } finally {
      delete process.env.FAKE_AGENT_INHERITED
      delete process.env.FAKE_AGENT_KEPT
    }
  })
})
