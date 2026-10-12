import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createCodexProvider } from "../agents/codex/codexProvider.ts"
import { channelKey } from "../channelKey.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import { createHarness, fakeAgentBin, lastStatus, liveAgentText, notices } from "../testing/harness.ts"

const browserWindow = "11111111-1111-4111-8111-111111111111"
const codexChannel = channelKey(browserWindow, "codex")
const claudeChannel = channelKey(browserWindow, "claude")
const codexSession = { agent: "codex" as const, conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", repository: "repo" }
const claudeSession = { agent: "claude" as const, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", repository: "repo" }

// The fake agent offers these modes to both providers: Codex starts in read-only, Claude in default.
beforeEach(() => {
  process.env.FAKE_AGENT_MODE_VALUES = "read-only,default,plan"
})

afterEach(() => {
  delete process.env.FAKE_AGENT_MODE_VALUES
})

function createBothAgents() {
  const codex = createCodexProvider({
    dataDir: "/tmp/bridge-parallel-codex",
    auth: {
      getAccessToken: () => Promise.resolve({ accessToken: "fake", expiresAt: 9_999_999_999_999 }),
      getStatus: () => ({ status: "signed_in", planUsage: true }),
    } as never,
    userCodexHome: undefined,
    agentMode: "read-only",
    model: undefined,
    refreshMarginMs: 1000,
    agentBin: fakeAgentBin,
  })
  const claude = createClaudeProvider({
    dataDir: "/tmp/bridge-parallel-claude",
    vault: createApiKeyVault({
      store: createMemorySecretStore("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"),
      env: () => undefined,
    }),
    userClaudeHome: "/tmp",
    agentBin: fakeAgentBin,
  })
  return createHarness({ providers: [codex, claude] })
}

describe("Codex and Claude in the same browser window", () => {
  it("keeps the turn of one agent running while the other one opens its chat and answers", async () => {
    const harness = createBothAgents()
    await harness.agents.handleMessage(codexChannel, { type: "chat_open", session: codexSession })
    // The turn never ends: Codex is "working" for the whole test.
    void harness.agents.handleMessage(codexChannel, {
      type: "chat_prompt",
      text: "hold-after-chunks m1 working|still-working",
      session: codexSession,
    })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(codexChannel))).toContain("still-working"))

    await harness.agents.handleMessage(claudeChannel, { type: "chat_open", session: claudeSession })
    await harness.agents.handleMessage(claudeChannel, { type: "chat_prompt", text: "say-chunks c1 claude-reply-ok", session: claudeSession })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(claudeChannel))).toContain("claude-reply-ok"))

    expect(lastStatus(harness.eventsFor(claudeChannel))).toBe("idle")
    expect(lastStatus(harness.eventsFor(codexChannel))).toBe("running")
    expect(notices(harness.eventsFor(codexChannel))).toEqual([])
    expect(notices(harness.eventsFor(claudeChannel))).toEqual([])
  })
})
