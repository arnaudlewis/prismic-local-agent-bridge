import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { chatHistory, createHarness, fakeAgentBin, lastThreads, session, windowA, windowB } from "../testing/harness.ts"

const leaked = "sk-ant-api03-LEAKEDBEFORETHEFIXLEAKEDBEFORE9999"
const odd = "an-odd-secret-0123456789abcdef"
const marker = "[redacted API key]"
const claudeSession = { ...session, agent: "claude" as const }
const stored = "00000000-0000-4000-8000-000000000001"
const other = "00000000-0000-4000-8000-000000000002"
const claudeChannel = (windowId: string) => `${windowId}/claude`

// What an earlier version wrote: the key is in the history, a tool title, a notice and the title.
function writePreFixConversation(dataDir: string, secret: string) {
  const dir = join(dataDir, "conversations")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const title = `use ${secret} please`
  writeFileSync(
    join(dir, `${stored}.json`),
    JSON.stringify({
      version: 1,
      conversationId: stored,
      agent: "claude",
      repository: "repo",
      title,
      updatedAt: 1000,
      events: [
        { type: "user_message", text: `here is my key ${secret}` },
        { type: "agent_message_chunk", text: `you sent ${secret}, thanks`, messageId: "m1" },
        { type: "tool_call", toolCallId: "t1", title: `curl -H "x-api-key: ${secret}"`, status: "completed" },
        { type: "notice", tone: "error", text: `rejected ${secret}` },
        { type: "turn_end", stopReason: "end_turn" },
      ],
    }),
  )
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({ version: 1, entries: [{ conversationId: stored, agent: "claude", repository: "repo", title, updatedAt: 1000 }] }),
  )
}

function setup(args: { stored?: string; dataDir: string }) {
  const store = createMemorySecretStore(args.stored)
  const vault = createApiKeyVault({ store, env: () => undefined })
  const provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault, userClaudeHome: "/tmp", agentBin: fakeAgentBin })
  return { harness: createHarness({ providers: [provider], dataDir: args.dataDir }), vault }
}

describe("a conversation stored before the daemon redacted keys", () => {
  it("is replayed without the key, before any agent starts and with no key configured", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-prefix-"))
    writePreFixConversation(dataDir, leaked)
    const { harness } = setup({ dataDir })

    await harness.agents.handleMessage(claudeChannel(windowA), { type: "chat_open", session: { ...claudeSession, conversationId: stored } })

    const history = JSON.stringify(chatHistory(harness.events))
    expect(history).not.toContain(leaked)
    expect(history).not.toContain("LEAKEDBEFORE")
    expect(history).toContain(`here is my key ${marker}`)
    expect(history).toContain(`you sent ${marker}, thanks`)
    expect(history).toContain(`x-api-key: ${marker}`)
    expect(JSON.stringify(harness.events)).not.toContain("LEAKEDBEFORE")
    harness.agents.stopAll()
  })

  it("is rewritten clean on disk when it is loaded", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-prefix-"))
    writePreFixConversation(dataDir, leaked)
    const { harness } = setup({ dataDir })

    await harness.agents.handleMessage(claudeChannel(windowA), { type: "chat_open", session: { ...claudeSession, conversationId: stored } })
    harness.agents.stopAll()

    const file = readFileSync(join(dataDir, "conversations", `${stored}.json`), "utf8")
    expect(file).not.toContain("LEAKEDBEFORE")
    expect(file).toContain(marker)
    const parsed = JSON.parse(file) as { title: string; events: unknown[] }
    expect(parsed.title).toBe(`use ${marker} please`)
    // The five stored events, plus the "add your key" notice of the agent that could not start.
    expect(parsed.events.length).toBeGreaterThanOrEqual(5)
  })

  it("is listed with a clean title, and the index is rewritten clean, without opening the conversation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-prefix-"))
    writePreFixConversation(dataDir, leaked)
    const { harness } = setup({ dataDir })

    // Another conversation gives the window its repository scope; the stored one is only listed.
    await harness.agents.handleMessage(claudeChannel(windowB), { type: "chat_open", session: { ...claudeSession, conversationId: other } })
    await harness.agents.handleMessage(claudeChannel(windowB), { type: "threads_list", repository: "repo", agent: "claude" })
    harness.agents.stopAll()

    const threads = lastThreads(harness.events)
    expect(threads?.map((thread) => thread.title)).toEqual([`use ${marker} please`])
    expect(readFileSync(join(dataDir, "conversations", "index.json"), "utf8")).not.toContain("LEAKEDBEFORE")
  })

  it("is replayed without a key the daemon knew and has since deleted, whatever its shape", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-prefix-"))
    writePreFixConversation(dataDir, odd)
    const { harness, vault } = setup({ dataDir, stored: odd })
    // The daemon reads the key (an agent start, a status) and later the user deletes it.
    await vault.get()
    await vault.remove()

    await harness.agents.handleMessage(claudeChannel(windowA), { type: "chat_open", session: { ...claudeSession, conversationId: stored } })

    const history = JSON.stringify(chatHistory(harness.events))
    expect(history).not.toContain(odd)
    expect(history).toContain(`here is my key ${marker}`)
    harness.agents.stopAll()
    expect(readFileSync(join(dataDir, "conversations", `${stored}.json`), "utf8")).not.toContain(odd)
  })

  it("is redacted at send time too: a key learned after the conversation was loaded", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-prefix-"))
    writePreFixConversation(dataDir, odd)
    const { harness, vault } = setup({ dataDir })
    await harness.agents.handleMessage(claudeChannel(windowA), { type: "chat_open", session: { ...claudeSession, conversationId: stored } })
    expect(JSON.stringify(chatHistory(harness.events))).toContain(odd)

    // The odd key is only learned now; the next replay (another window opening it) no longer shows it.
    await vault.set(odd)
    harness.events.length = 0
    await harness.agents.handleMessage(claudeChannel(windowB), { type: "chat_open", session: { ...claudeSession, conversationId: stored } })

    expect(JSON.stringify(chatHistory(harness.events))).not.toContain(odd)
    harness.agents.stopAll()
  })
})
