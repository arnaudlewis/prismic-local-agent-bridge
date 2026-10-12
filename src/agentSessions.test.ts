import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createAgentSessions, isSlashCommand, toBridgeCommand } from "./agentSessions.ts"
import type { AgentSessions } from "./agentSessions.ts"
import { ClientMessageSchema } from "./protocol.ts"
import type { BridgeConfigOption, BridgeEvent, HistoryEvent, Session } from "./protocol.ts"
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
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const session: Session = {
  conversationId,
  mcpServerUrl: "http://localhost:3030/mcp",
  prismicToken: "token",
  repository: "repo",
}

interface Harness {
  agents: AgentSessions
  events: BridgeEvent[]
  dataDir: string
  eventsFor(windowId: string): BridgeEvent[]
  lastMode(): BridgeConfigOption | undefined
}

const running: AgentSessions[] = []

afterEach(() => {
  for (const agents of running.splice(0)) agents.stopAll()
})

interface CreateHarnessArgs {
  allowFullAccess?: boolean
  dataDir?: string
  idleTtlMs?: number
}

function createHarness(args: CreateHarnessArgs = {}): Harness {
  const events: BridgeEvent[] = []
  const byWindow = new Map<string, BridgeEvent[]>()
  const dataDir = args.dataDir ?? mkdtempSync(join(tmpdir(), "bridge-test-"))
  const channels: WindowChannels = {
    attach: () => {},
    send: (target, event) => {
      events.push(event)
      byWindow.set(target, [...(byWindow.get(target) ?? []), event])
    },
    onMessage: () => {},
    onWindowClosed: () => {},
  }
  const agents = createAgentSessions({
    channels,
    auth: { getAccessToken: () => Promise.resolve({ accessToken: "fake", expiresAt: 9_999_999_999_999 }) } as never,
    dataDir,
    userCodexHome: undefined,
    allowFullAccess: args.allowFullAccess ?? false,
    agentBin: fakeAgentBin,
    idleTtlMs: args.idleTtlMs,
    projectDir: tmpdir(),
    agentMode: "read-only",
    model: undefined,
    refreshMarginMs: 1000,
  })
  running.push(agents)
  return {
    agents,
    events,
    dataDir,
    eventsFor: (target) => byWindow.get(target) ?? [],
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
    const harness = createHarness()
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
    const harness = createHarness()
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
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "set_config_option", configId: "mode", value: "agent" })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session: { ...session, prismicToken: "other" } })
    expect(harness.lastMode()?.currentValue).toBe("agent")

    await harness.agents.handleMessage(windowId, { type: "chat_reset" })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})

describe("blocked commands", () => {
  const blocked = ["logout", "review", "review-branch", "review-commit", "goal"]

  function promptedTexts(events: BridgeEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === "agent_message_chunk" && event.text.startsWith("prompt:") ? [event.text.slice(7)] : [],
    )
  }

  it("never lists blocked commands but keeps the others", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    const lists = harness.events.filter((event) => event.type === "available_commands")
    expect(lists.length).toBeGreaterThan(0)
    for (const list of lists) {
      const names = list.commands.map((command) => command.name)
      expect(names).toEqual(["status", "mcp", "compact", "rename", "$skill"])
    }
  })

  it.each(blocked.flatMap((name) => [`/${name}`, `/${name.toUpperCase()} some args`, `  /${name}\n`]))(
    "does not forward %j and answers with a notice",
    async (text) => {
      const harness = createHarness()
      await harness.agents.handleMessage(windowId, { type: "chat_open", session })
      harness.events.length = 0

      await harness.agents.handleMessage(windowId, { type: "chat_prompt", text, session })

      const name = text.trim().slice(1).split(/\s/)[0]?.toLowerCase()
      expect(promptedTexts(harness.events)).toEqual([])
      expect(notices(harness.events)).toEqual([`The /${name} command isn't available in the local agent.`])
      expect(harness.events.some((event) => event.type === "notice" && event.tone === "error")).toBe(true)
      expect(harness.events.at(-1)).toEqual({ type: "chat_status", status: "idle" })
    },
  )

  it.each(["/status", "/mcp", "/plan", "/compact", "/rename new name", "$skill", "/reviewer"])(
    "still forwards %j",
    async (text) => {
      const harness = createHarness()
      await harness.agents.handleMessage(windowId, { type: "chat_open", session })
      harness.events.length = 0

      await harness.agents.handleMessage(windowId, { type: "chat_prompt", text, session })

      expect(notices(harness.events)).toEqual([])
      expect(promptedTexts(harness.events)).toContain(text)
      expect(harness.events.some((event) => event.type === "turn_end")).toBe(true)
    },
  )
})

describe("collaboration mode", () => {
  function lastOption(harness: Harness, id: string): BridgeConfigOption | undefined {
    const configs = harness.events.filter((event) => event.type === "session_config")
    return configs.at(-1)?.options.find((option) => option.id === id)
  }

  it("relays the collaboration_mode option unchanged", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    const option = lastOption(harness, "collaboration_mode")
    expect(option?.category).toBe("collaboration_mode")
    expect(option?.currentValue).toBe("default")
    expect(option?.values.map((entry) => entry.value)).toEqual(["default", "plan"])
  })

  it("accepts set_config_option, keeps it across an agent restart and clears it on chat_reset", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "collaboration_mode",
      value: "plan",
    })
    expect(notices(harness.events)).toEqual([])
    expect(lastOption(harness, "collaboration_mode")?.currentValue).toBe("plan")

    await harness.agents.handleMessage(windowId, { type: "chat_open", session: { ...session, prismicToken: "other" } })
    expect(lastOption(harness, "collaboration_mode")?.currentValue).toBe("plan")

    await harness.agents.handleMessage(windowId, { type: "chat_reset" })
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(lastOption(harness, "collaboration_mode")?.currentValue).toBe("default")
  })

  it("hides /plan from the list but still forwards a typed /plan", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    harness.events.length = 0

    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "/plan", session })

    expect(notices(harness.events)).toEqual([])
    expect(
      harness.events.some((event) => event.type === "agent_message_chunk" && event.text === "prompt:/plan"),
    ).toBe(true)
  })
})

const windowA = "aaaaaaaa-0000-4000-8000-00000000000a"
const windowB = "bbbbbbbb-0000-4000-8000-00000000000b"
const windowC = "cccccccc-0000-4000-8000-00000000000c"

function chatHistory(events: BridgeEvent[]): HistoryEvent[] {
  const history = events.findLast((event) => event.type === "chat_history")
  return history?.type === "chat_history" ? history.events : []
}

function agentText(events: HistoryEvent[]): string {
  return events.flatMap((event) => (event.type === "agent_message_chunk" ? [event.text] : [])).join("")
}

function liveAgentText(events: BridgeEvent[]): string {
  return events.flatMap((event) => (event.type === "agent_message_chunk" ? [event.text] : [])).join("")
}

function lastStatus(events: BridgeEvent[]): string | undefined {
  const status = events.findLast((event) => event.type === "chat_status")
  return status?.type === "chat_status" ? status.status : undefined
}

function conversationFile(harness: Harness): string {
  return join(harness.dataDir, "conversations", `${conversationId}.json`)
}

describe("persistent conversations", () => {
  it("replays the history to a second window, before session_config, and stops feeding the first", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })

    const eventsB = harness.eventsFor(windowB)
    const kinds = eventsB.map((event) => event.type)
    expect(kinds[0]).toBe("chat_history")
    expect(kinds.indexOf("chat_history")).toBeLessThan(kinds.indexOf("session_config"))
    expect(kinds.indexOf("chat_history")).toBeLessThan(kinds.indexOf("available_commands"))
    const history = chatHistory(eventsB)
    expect(history[0]).toEqual({ type: "user_message", text: "hello" })
    expect(history.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" })
    expect(history.filter((event) => event.type === "agent_message_chunk")).toHaveLength(1)
    expect(agentText(history)).toContain(`ctx:new:${windowA}`)
    expect(lastStatus(eventsB)).toBe("idle")

    const countA = harness.eventsFor(windowA).length
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "again", session })
    expect(harness.eventsFor(windowA)).toHaveLength(countA)
    expect(liveAgentText(harness.eventsFor(windowB))).toContain("prompt:again")
  })

  it("restarts the agent with resume when the window changes, binding the MCP header to the new window", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "first", session })
    expect(liveAgentText(harness.eventsFor(windowA))).toContain(`ctx:new:${windowA}`)

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "second", session })

    const textB = liveAgentText(harness.eventsFor(windowB))
    expect(textB).toContain(`ctx:load:${windowB}`)
    expect(textB).not.toContain("replayed-history")
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)
    expect(harness.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)
  })

  it("does not start a resume for a conversation that never got a prompt", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "first", session })

    expect(liveAgentText(harness.eventsFor(windowB))).toContain(`ctx:new:${windowB}`)
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)
  })

  it("keeps a turn running after the window goes away and shows it as running to the next window", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    const countA = harness.eventsFor(windowA).length

    harness.agents.detachWindow(windowA)
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })

    const eventsB = harness.eventsFor(windowB)
    const history = chatHistory(eventsB)
    expect(history[0]).toEqual({ type: "user_message", text: "hold on" })
    expect(agentText(history)).toBe("working")
    expect(lastStatus(eventsB)).toBe("running")
    expect(harness.eventsFor(windowA)).toHaveLength(countA)

    await harness.agents.handleMessage(windowB, { type: "chat_cancel" })
    await turn
    expect(harness.eventsFor(windowB)).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
    expect(lastStatus(harness.eventsFor(windowB))).toBe("idle")
  })

  it("records events produced while no window is attached", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    harness.agents.detachWindow(windowA)

    await harness.agents.handleMessage(windowC, { type: "chat_open", session })
    const request = chatHistory(harness.eventsFor(windowC)).find((event) => event.type === "permission_request")
    expect(request).toBeDefined()
    await harness.agents.handleMessage(windowC, {
      type: "permission_response",
      requestId: request?.type === "permission_request" ? request.requestId : "",
      optionId: "allow",
    })
    await turn
    expect(liveAgentText(harness.eventsFor(windowC))).toContain("permission:allow")
  })

  it("keeps an unresolved permission request answerable after a refresh and marks resolved ones", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    const pendingHistory = chatHistory(harness.eventsFor(windowB))
    const request = pendingHistory.find((event) => event.type === "permission_request")
    expect(request).toMatchObject({ type: "permission_request", title: "Run tool" })
    expect(pendingHistory.some((event) => event.type === "permission_resolved")).toBe(false)
    expect(lastStatus(harness.eventsFor(windowB))).toBe("running")

    const requestId = request?.type === "permission_request" ? request.requestId : ""
    await harness.agents.handleMessage(windowB, { type: "permission_response", requestId, optionId: "allow" })
    await turn

    await harness.agents.handleMessage(windowC, { type: "chat_open", session })
    const resolvedHistory = chatHistory(harness.eventsFor(windowC))
    const kinds = resolvedHistory.map((event) => event.type)
    expect(kinds.indexOf("permission_resolved")).toBeGreaterThan(kinds.indexOf("permission_request"))
    expect(resolvedHistory.find((event) => event.type === "permission_resolved")).toEqual({
      type: "permission_resolved",
      requestId,
      optionId: "allow",
    })
    expect(agentText(resolvedHistory)).toContain("permission:allow")
  })

  it("records a cancelled permission without an optionId", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(harness.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    const request = harness.eventsFor(windowA).find((event) => event.type === "permission_request")

    await harness.agents.handleMessage(windowA, {
      type: "permission_response",
      requestId: request?.type === "permission_request" ? request.requestId : "",
    })
    await turn

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    const resolved = chatHistory(harness.eventsFor(windowB)).find((event) => event.type === "permission_resolved")
    expect(resolved).toEqual({ type: "permission_resolved", requestId: expect.any(String) })
    expect(agentText(chatHistory(harness.eventsFor(windowB)))).toContain("permission:cancelled")
  })

  it("survives a daemon restart: history comes back from disk and the agent resumes with loadSession", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    await first.agents.handleMessage(windowA, { type: "chat_prompt", text: "use-tool please", session })
    first.agents.stopAll()

    const file = conversationFile(first)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; acpSessionId?: string; repository: string }
    expect(onDisk).toMatchObject({ version: 1, repository: "repo", acpSessionId: "fake-session" })

    const second = createHarness({ dataDir: first.dataDir })
    await second.agents.handleMessage(windowB, { type: "chat_open", session })

    const history = chatHistory(second.eventsFor(windowB))
    expect(history[0]).toEqual({ type: "user_message", text: "use-tool please" })
    expect(history.map((event) => event.type)).toEqual([
      "user_message",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "turn_end",
    ])
    expect(second.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)

    await second.agents.handleMessage(windowB, { type: "chat_prompt", text: "next", session })
    const live = liveAgentText(second.eventsFor(windowB))
    expect(live).toContain(`ctx:load:${windowB}`)
    expect(live).not.toContain("replayed-history")
    expect(second.events.some((event) => event.type === "notice")).toBe(false)
    // The preamble was already sent in the first run, so it must not be sent again.
    expect(live).not.toContain("You are running inside")
  })

  it("persists a transcript that a restart marks as unresolved permissions cancelled", async () => {
    const first = createHarness()
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    void first.agents.handleMessage(windowA, { type: "chat_prompt", text: "ask-permission", session })
    await vi.waitFor(() =>
      expect(first.eventsFor(windowA).some((event) => event.type === "permission_request")).toBe(true),
    )
    first.agents.stopAll()

    const second = createHarness({ dataDir: first.dataDir })
    await second.agents.handleMessage(windowB, { type: "chat_open", session })

    const kinds = chatHistory(second.eventsFor(windowB)).map((event) => event.type)
    expect(kinds).toContain("permission_request")
    expect(kinds.at(-1)).toBe("permission_resolved")
  })

  it("deletes the transcript, the stored session and the file on chat_reset, and starts fresh", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "first", session })
    await vi.waitFor(() => expect(existsSync(conversationFile(harness))).toBe(true))

    await harness.agents.handleMessage(windowA, { type: "chat_reset" })
    expect(existsSync(conversationFile(harness))).toBe(false)

    harness.events.length = 0
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    expect(chatHistory(harness.events)).toEqual([])
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "second", session })
    const text = liveAgentText(harness.events)
    expect(text).toContain("ctx:new")
    expect(text).toContain("You are running inside")
    expect(harness.events.some((event) => event.type === "notice")).toBe(false)

    harness.agents.stopAll()
    const restarted = createHarness({ dataDir: harness.dataDir })
    await restarted.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(chatHistory(restarted.eventsFor(windowB)).map((event) => event.type)).not.toContain("tool_call")
    expect(chatHistory(restarted.eventsFor(windowB))[0]).toEqual({ type: "user_message", text: "second" })
  })

  it("ignores a corrupt stored conversation and starts fresh", async () => {
    const harness = createHarness()
    mkdirSync(join(harness.dataDir, "conversations"), { recursive: true })
    writeFileSync(conversationFile(harness), "not json at all")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(chatHistory(harness.eventsFor(windowA))).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not json at all")
    warn.mockRestore()
    expect(harness.eventsFor(windowA).some((event) => event.type === "session_config")).toBe(true)
  })

  it("stops an idle conversation without a window after the TTL but keeps it on disk", async () => {
    const harness = createHarness({ idleTtlMs: 50 })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })
    harness.agents.detachWindow(windowA)

    await vi.waitFor(() => expect(existsSync(conversationFile(harness))).toBe(true))

    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(chatHistory(harness.eventsFor(windowB))[0]).toEqual({ type: "user_message", text: "hello" })
    expect(harness.eventsFor(windowB).some((event) => event.type === "session_config")).toBe(true)
  })

  it("ignores messages from a window that was replaced by a newer one", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    harness.eventsFor(windowA).length = 0

    await harness.agents.handleMessage(windowA, { type: "set_config_option", configId: "mode", value: "agent" })

    expect(harness.eventsFor(windowA)).toEqual([
      { type: "notice", tone: "info", text: "The local agent isn't running yet." },
    ])
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})

describe("conversationId validation", () => {
  const base = { mcpServerUrl: "http://localhost:3030/mcp", prismicToken: "token", repository: "repo" }

  it.each([
    "../../etc/passwd",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../x",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
    "",
  ])("rejects %j", (id) => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: { ...base, conversationId: id } }).success).toBe(
      false,
    )
    expect(
      ClientMessageSchema.safeParse({ type: "chat_prompt", text: "hi", session: { ...base, conversationId: id } })
        .success,
    ).toBe(false)
  })

  it("requires a conversationId and accepts a lowercase UUID v4", () => {
    expect(ClientMessageSchema.safeParse({ type: "chat_open", session: base }).success).toBe(false)
    expect(
      ClientMessageSchema.safeParse({
        type: "chat_open",
        session: { ...base, conversationId: crypto.randomUUID() },
      }).success,
    ).toBe(true)
  })
})
