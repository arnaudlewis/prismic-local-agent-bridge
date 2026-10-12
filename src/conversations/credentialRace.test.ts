import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { createHarness, fakeAgentBin, lastStatus, notices, session, windowA, windowB } from "../testing/harness.ts"

const keyA = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA1111"
const keyB = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBB2222"
const claudeSession = { ...session, agent: "claude" as const }
const first = `${windowA}/claude`
const second = `${windowB}/claude`
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let startLog = ""

beforeEach(() => {
  process.env.FAKE_AGENT_MODE_VALUES = "default,plan"
  startLog = join(mkdtempSync(join(tmpdir(), "bridge-race-")), "start.log")
  process.env.FAKE_AGENT_START_LOG = startLog
})

afterEach(() => {
  delete process.env.FAKE_AGENT_MODE_VALUES
  delete process.env.FAKE_AGENT_START_LOG
  delete process.env.FAKE_AGENT_INIT_DELAY_MS
})

function log(): string[] {
  try {
    return readFileSync(startLog, "utf8").split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function setup(stored: string | undefined = keyA) {
  const store = createMemorySecretStore(stored)
  const vault = createApiKeyVault({ store, env: () => undefined })
  const provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault, userClaudeHome: "/tmp", agentBin: fakeAgentBin })
  const harness = createHarness({ providers: [provider] })
  const removeKey = () =>
    provider.routes?.().find((route) => route.method === "DELETE")?.handle({
      req: {} as never,
      res: { writeHead: () => {}, end: () => {} } as never,
      url: new URL("http://x/"),
      paired: undefined,
    })
  return { harness, vault, store, provider, removeKey }
}

describe("credentials that change while an agent is getting ready", () => {
  it("does not start an agent with the removed key when the old agent was slow to exit", async () => {
    const { harness, removeKey } = setup()
    await harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(first, { type: "chat_prompt", text: "delay-exit 700", session: claudeSession })
    expect(log()).toEqual(["start:1111"])
    harness.events.length = 0

    // Another window opens the conversation: the agent must restart (its MCP window changes), so the old one is
    // stopped and the restart waits for it to leave. The key is deleted in the meantime.
    const restart = harness.agents.handleMessage(second, { type: "chat_open", session: claudeSession })
    await pause(150)
    await removeKey()
    await restart
    await pause(900)

    expect(log().filter((line) => line.startsWith("start:"))).toEqual(["start:1111"])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(lastStatus(harness.events)).toBe("idle")
  })

  it("starts with the new key, not the old one, when the key was replaced while the old agent was exiting", async () => {
    const { harness, vault } = setup()
    await harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(first, { type: "chat_prompt", text: "delay-exit 700", session: claudeSession })
    harness.events.length = 0

    const restart = harness.agents.handleMessage(second, { type: "chat_open", session: claudeSession })
    await pause(150)
    await vault.set(keyB)
    await restart

    expect(log().filter((line) => line.startsWith("start:"))).toEqual(["start:1111", "start:2222"])
    expect(notices(harness.events)).toEqual([])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(true)
  })

  it("kills a child that was spawned and is still handshaking when the key is removed, and never makes it the agent", async () => {
    process.env.FAKE_AGENT_INIT_DELAY_MS = "700"
    const { harness, removeKey } = setup()
    const opening = harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await vi.waitFor(() => expect(log()).toEqual(["start:1111"]))

    await removeKey()
    await opening
    await pause(300)

    expect(log()).toContain("sigterm")
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(lastStatus(harness.events)).toBe("idle")
    // Nothing is running for the conversation anymore: the next prompt asks for the key again.
    harness.events.length = 0
    await harness.agents.handleMessage(first, { type: "chat_prompt", text: "hello", session: claudeSession })
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
  })

  it("restarts with the new key when the key was replaced during the handshake of the agent started with the old one", async () => {
    process.env.FAKE_AGENT_INIT_DELAY_MS = "500"
    const { harness, vault } = setup()
    const opening = harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await vi.waitFor(() => expect(log()).toEqual(["start:1111"]))

    await vault.set(keyB)
    await opening

    expect(log().filter((line) => line.startsWith("start:"))).toEqual(["start:1111", "start:2222"])
    expect(log()).toContain("sigterm")
    expect(notices(harness.events)).toEqual([])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(true)
  })

  it("aborts a conversation that is only authenticating when the key is removed, without starting anything", async () => {
    const { harness, vault, provider, removeKey } = setup()
    const slow = provider.authenticate.bind(provider)
    provider.authenticate = async () => {
      const credentials = await slow()
      await pause(300)
      return credentials
    }
    const opening = harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await pause(100)

    await removeKey()
    await opening

    expect(log()).toEqual([])
    expect(await vault.get()).toBeUndefined()
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
  })

  it("stops a running agent at once when the key is removed", async () => {
    const { harness, removeKey } = setup()
    await harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    harness.events.length = 0

    await removeKey()

    await vi.waitFor(() => expect(log()).toContain("sigterm"))
    expect(notices(harness.events)).toEqual(["Add your Anthropic API key to use Claude."])
    expect(lastStatus(harness.events)).toBe("idle")
  })

  it("gives up after the key changed twice in a row instead of looping", async () => {
    process.env.FAKE_AGENT_INIT_DELAY_MS = "300"
    const { harness, vault } = setup()
    const opening = harness.agents.handleMessage(first, { type: "chat_open", session: claudeSession })
    await vi.waitFor(() => expect(log()).toEqual(["start:1111"]))
    await vault.set(keyB)
    await vi.waitFor(() => expect(log().filter((line) => line.startsWith("start:"))).toHaveLength(2))
    await vault.set(keyA)
    await opening

    expect(log().filter((line) => line.startsWith("start:")).length).toBeLessThanOrEqual(2)
    expect(harness.events.some((event) => event.type === "session_config")).toBe(false)
    expect(lastStatus(harness.events)).toBe("idle")
  })
})
