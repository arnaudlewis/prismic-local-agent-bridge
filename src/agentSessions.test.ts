import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { createAgentSessions, isSlashCommand, toBridgeCommand } from "./agentSessions.ts"
import type { AgentSessions } from "./agentSessions.ts"
import type { BridgeConfigOption, BridgeEvent, Session } from "./protocol.ts"
import type { WindowChannels } from "./windowChannels.ts"

describe("isSlashCommand", () => {
  it.each(["/status", "  /review check the diff", "/review-branch main", "/compact\n"])("detects %j", (text) => {
    expect(isSlashCommand(text)).toBe(true)
  })

  it.each(["status", "what does /status do", "/etc/hosts", "/$skill", "//", "/"])("ignores %j", (text) => {
    expect(isSlashCommand(text)).toBe(false)
  })
})

describe("toBridgeCommand", () => {
  it("keeps the hint of unstructured input", () => {
    expect(toBridgeCommand({ name: "review", description: "Review.", input: { hint: "instructions" } })).toEqual({
      name: "review",
      description: "Review.",
      hint: "instructions",
    })
  })

  it("omits the hint without input", () => {
    expect(toBridgeCommand({ name: "status", description: "Status.", input: null })).toEqual({
      name: "status",
      description: "Status.",
    })
    expect(toBridgeCommand({ name: "$skill", description: "Skill." })).toEqual({
      name: "$skill",
      description: "Skill.",
    })
  })
})

const fakeAgentBin = fileURLToPath(new URL("./testing/fakeAcpAgent.ts", import.meta.url))
const windowId = "11111111-1111-4111-8111-111111111111"
const session: Session = { mcpServerUrl: "http://localhost:3030/mcp", prismicToken: "token", repository: "repo" }

interface Harness {
  agents: AgentSessions
  events: BridgeEvent[]
  lastMode(): BridgeConfigOption | undefined
}

const running: AgentSessions[] = []

afterEach(() => {
  for (const agents of running.splice(0)) agents.stopAll()
})

function createHarness(args: { allowFullAccess: boolean }): Harness {
  const events: BridgeEvent[] = []
  const channels: WindowChannels = {
    attach: () => {},
    send: (_windowId, event) => events.push(event),
    onMessage: () => {},
    onWindowClosed: () => {},
  }
  const agents = createAgentSessions({
    channels,
    auth: { getAccessToken: () => Promise.resolve({ accessToken: "fake", expiresAt: Date.now() + 3_600_000 }) } as never,
    dataDir: mkdtempSync(join(tmpdir(), "bridge-test-")),
    userCodexHome: undefined,
    allowFullAccess: args.allowFullAccess,
    agentBin: fakeAgentBin,
    projectDir: tmpdir(),
    agentMode: "read-only",
    model: undefined,
    refreshMarginMs: 1000,
  })
  running.push(agents)
  return {
    agents,
    events,
    lastMode() {
      const configs = events.filter((event) => event.type === "session_config")
      return configs.at(-1)?.options.find((option) => option.id === "mode")
    },
  }
}

function notices(events: BridgeEvent[]): string[] {
  return events.flatMap((event) => (event.type === "notice" ? [event.text] : []))
}

const disabledNotice = "Full access is disabled. Restart the bridge with --allow-full-access to enable it."

describe("full access guard", () => {
  it("hides agent-full-access from session_config and rejects selecting it", async () => {
    const harness = createHarness({ allowFullAccess: false })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.values.map((entry) => entry.value)).toEqual(["read-only", "workspace-write", "agent"])

    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "mode",
      value: "agent-full-access",
    })

    expect(notices(harness.events)).toContain(disabledNotice)
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })

  it("still allows other modes", async () => {
    const harness = createHarness({ allowFullAccess: false })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "set_config_option", configId: "mode", value: "agent" })

    expect(notices(harness.events)).toEqual([])
    expect(harness.lastMode()?.currentValue).toBe("agent")
  })

  it("offers and accepts agent-full-access when allowed", async () => {
    const harness = createHarness({ allowFullAccess: true })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.values.map((entry) => entry.value)).toContain("agent-full-access")

    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "mode",
      value: "agent-full-access",
    })

    expect(notices(harness.events)).toEqual([])
    expect(harness.lastMode()?.currentValue).toBe("agent-full-access")
  })
})

describe("preferredConfig", () => {
  it.each([false, true])("never changes the mode at chat_open (allowFullAccess: %s)", async (allowFullAccess) => {
    const harness = createHarness({ allowFullAccess })
    await harness.agents.handleMessage(windowId, {
      type: "chat_open",
      session,
      preferredConfig: { mode: "agent-full-access" },
    })

    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })

  it("keeps the mode chosen with set_config_option across an agent restart, and resets it on chat_reset", async () => {
    const harness = createHarness({ allowFullAccess: false })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "set_config_option", configId: "mode", value: "agent" })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session: { ...session, prismicToken: "other" } })
    expect(harness.lastMode()?.currentValue).toBe("agent")

    await harness.agents.handleMessage(windowId, { type: "chat_reset" })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})
