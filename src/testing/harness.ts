import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach } from "vitest"

import { createCodexProvider } from "../agents/codex/codexProvider.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { createAgentSessions } from "../agentSessions.ts"
import type { AgentSessions } from "../agentSessions.ts"
import type { BridgeConfigOption, BridgeEvent, HistoryEvent, Session } from "../protocol.ts"
import type { WindowChannels } from "../windowChannels.ts"

export const fakeAgentBin = fileURLToPath(new URL("./fakeAcpAgent.ts", import.meta.url))
export const windowId = "11111111-1111-4111-8111-111111111111"
export const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const session: Session = {
  agent: "codex",
  conversationId,
  mcpServerUrl: "http://localhost:3030/mcp",
  prismicToken: "token",
  repository: "repo",
}

export interface Harness {
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

// The environment knobs of the fake agent: handed to it like a user would with --pass-env, since the agents no longer
// inherit the daemon's whole environment.
export const fakeAgentEnvNames = [
  "FAKE_AGENT_COMMANDS",
  "FAKE_AGENT_FAIL_LOAD",
  "FAKE_AGENT_INHERITED",
  "FAKE_AGENT_INIT_DELAY_MS",
  "FAKE_AGENT_KEPT",
  "FAKE_AGENT_LOG",
  "FAKE_AGENT_MODE_VALUES",
  "FAKE_AGENT_SECRET",
  "FAKE_AGENT_SLOW_CONFIG_MS",
  "FAKE_AGENT_START_LOG",
]

export interface CreateHarnessArgs {
  dataDir?: string
  idleTtlMs?: number
  maxLiveAgents?: number
  maxConversations?: number
  detachedActivityLimitMs?: number
  detachedSweepIntervalMs?: number
  // Off by default: most tests don't run an MCP server, and a failed read would add a notice to every prompt.
  readEditorContext?: boolean
  contextReadTimeoutMs?: number
  // Replaces parts of the Codex provider (blocked commands, notices, ...) to show the machinery goes through it.
  providerOverrides?: Partial<AgentProvider>
  // Replaces the names handed to the agent on top of the allowlist (the fake agent's own knobs by default).
  passEnv?: string[]
  // Replaces the provider list altogether (e.g. none).
  providers?: AgentProvider[]
}

export function createHarness(args: CreateHarnessArgs = {}): Harness {
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
  const codex = createCodexProvider({
    dataDir,
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
  const agents = createAgentSessions({
    channels,
    dataDir,
    projectDir: tmpdir(),
    providers: args.providers ?? [{ ...codex, ...args.providerOverrides }],
    passEnv: args.passEnv ?? fakeAgentEnvNames,
    idleTtlMs: args.idleTtlMs,
    maxLiveAgents: args.maxLiveAgents,
    maxConversations: args.maxConversations,
    detachedActivityLimitMs: args.detachedActivityLimitMs,
    detachedSweepIntervalMs: args.detachedSweepIntervalMs,
    readEditorContext: args.readEditorContext ?? false,
    contextReadTimeoutMs: args.contextReadTimeoutMs,
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

export function notices(events: BridgeEvent[]): string[] {
  return events.flatMap((event) => (event.type === "notice" ? [event.text] : []))
}

export const windowA = "aaaaaaaa-0000-4000-8000-00000000000a"
export const windowB = "bbbbbbbb-0000-4000-8000-00000000000b"
export const windowC = "cccccccc-0000-4000-8000-00000000000c"

export function chatHistory(events: BridgeEvent[]): HistoryEvent[] {
  const history = events.findLast((event) => event.type === "chat_history")
  return history?.type === "chat_history" ? history.events : []
}

export function agentText(events: HistoryEvent[]): string {
  return events.flatMap((event) => (event.type === "agent_message_chunk" ? [event.text] : [])).join("")
}

export function liveAgentText(events: BridgeEvent[]): string {
  return events.flatMap((event) => (event.type === "agent_message_chunk" ? [event.text] : [])).join("")
}

export function lastStatus(events: BridgeEvent[]): string | undefined {
  const status = events.findLast((event) => event.type === "chat_status")
  return status?.type === "chat_status" ? status.status : undefined
}

export function conversationFile(harness: Harness): string {
  return join(harness.dataDir, "conversations", `${conversationId}.json`)
}

export function editorContextEvents(events: BridgeEvent[]) {
  return events.flatMap((event) => (event.type === "editor_context" ? [event] : []))
}

export function toolText(identity: string, payload: unknown): string {
  return `emit-tool ${identity} ${typeof payload === "string" ? payload : JSON.stringify(payload)}`
}

export const windowDocument = {
  id: "DOC1",
  title: "Home",
  customTypeId: "page",
  customTypeLabel: "Page",
  versionStatus: "unclassified",
  locale: "en-us",
  section: "Main",
  readOnly: false,
  uid: "home",
  hasUnsavedChanges: true,
  focusedSlice: {
    path: "slices[hero$1]",
    name: "Hero",
    variation: "default",
    item: { secret: "slice-item-secret" },
    paths: ["slices[hero$1].primary.title"],
  },
  focusedField: { nodeId: "n1", label: "Title", type: "StructuredText" },
  content: { secret: "document-content-secret" },
  paths: ["a.b"],
}

export function contextWindow(document: object = windowDocument) {
  return { windowId: "w", repository: "repo", url: "http://x", page: "documentEditor", focused: true, document }
}


export function conversationIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
}

export function sessionFor(index: number): Session {
  return { ...session, conversationId: conversationIdFor(index) }
}

export function windowFor(index: number): string {
  return `99999999-0000-4000-8000-${String(index).padStart(12, "0")}`
}

export async function openAndPrompt(harness: Harness, index: number, text = "hello") {
  await harness.agents.handleMessage(windowFor(index), { type: "chat_open", session: sessionFor(index) })
  await harness.agents.handleMessage(windowFor(index), { type: "chat_prompt", text, session: sessionFor(index) })
}

export const tooMany = "Too many active conversations. Finish or reset one first."


export interface StoredFixture {
  repository?: string
  title?: string
  updatedAt: number
  events?: unknown[]
}

export function writeStored(dataDir: string, id: string, fixture: StoredFixture): void {
  mkdirSync(join(dataDir, "conversations"), { recursive: true })
  writeFileSync(
    join(dataDir, "conversations", `${id}.json`),
    JSON.stringify({
      version: 1,
      conversationId: id,
      repository: fixture.repository ?? "repo",
      ...(fixture.title === undefined ? {} : { title: fixture.title }),
      updatedAt: fixture.updatedAt,
      events: fixture.events ?? [{ type: "user_message", text: `message ${id.slice(-4)}` }],
    }),
  )
}

export function threadEvents(events: BridgeEvent[]) {
  return events.flatMap((event) => (event.type === "threads" ? [event.threads] : []))
}

export function lastThreads(events: BridgeEvent[]) {
  return threadEvents(events).at(-1)
}

export function indexFile(dataDir: string): string {
  return join(dataDir, "conversations", "index.json")
}

export function readIndex(dataDir: string): { version: number; entries: Array<{ conversationId: string; repository: string; title: string; updatedAt: number }> } {
  return JSON.parse(readFileSync(indexFile(dataDir), "utf8"))
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))


// Gives a window a scope (the repository of its last accepted session) without leaving events behind: threads_list
// is answered for that repository only.
export async function openScope(harness: Harness, target: string, repository = "repo"): Promise<void> {
  await harness.agents.handleMessage(target, {
    type: "chat_open",
    session: { ...session, conversationId: conversationIdFor(990), repository },
  })
  harness.eventsFor(target).length = 0
}
