import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentRuntime } from "../agents/agentRuntime.ts"
import { createCodexProvider } from "../agents/codex/codexProvider.ts"
import { chatHistory, createHarness, fakeAgentBin, lastStatus, liveAgentText, notices, session, windowA } from "../testing/harness.ts"

const downloadNotice = "Downloading Codex for this computer (about 120 MB). This happens only once."
let startLog = ""

beforeEach(() => {
  startLog = join(mkdtempSync(join(tmpdir(), "bridge-download-")), "start.log")
  process.env.FAKE_AGENT_START_LOG = startLog
})

afterEach(() => {
  delete process.env.FAKE_AGENT_START_LOG
})

function agentStarts(): number {
  try {
    return readFileSync(startLog, "utf8").split("\n").filter((line) => line.startsWith("start:")).length
  } catch {
    return 0
  }
}

// An agent runtime whose download the test finishes (or fails) by hand.
function createControlledRuntime() {
  let ready = false
  const calls: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  const runtime: AgentRuntime = {
    sizeLabel: "about 120 MB",
    isReady: () => ready,
    env: () => ({}),
    ensure() {
      return new Promise<void>((resolve, reject) => {
        calls.push({
          resolve: () => {
            ready = true
            resolve()
          },
          reject,
        })
      })
    },
  }
  return { runtime, calls }
}

function setup() {
  const { runtime, calls } = createControlledRuntime()
  const dataDir = mkdtempSync(join(tmpdir(), "bridge-download-data-"))
  const provider = createCodexProvider({
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
    runtime,
  })
  return { harness: createHarness({ dataDir, providers: [provider] }), calls }
}

describe("agent binary download", () => {
  it("tells the window once, keeps the notice out of the transcript and answers the prompt after the download", async () => {
    const { harness, calls } = setup()

    const opening = harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(notices(harness.eventsFor(windowA))).toEqual([downloadNotice])
    calls[0]?.resolve()
    await opening
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })

    await vi.waitFor(() => expect(liveAgentText(harness.events)).toContain("prompt:hello"))
    // Opening the chat again sends the stored transcript: the download notice is live only, so it must not be there.
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    expect(chatHistory(harness.events).some((event) => event.type === "notice")).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("reports a failed download and tries again on the next prompt", async () => {
    const { harness, calls } = setup()

    const opening = harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0]?.reject(new Error("download failed (HTTP 503)"))
    await opening

    expect(notices(harness.events)).toContain(
      "Couldn't download Codex: download failed (HTTP 503). Send a message to try again.",
    )
    expect(lastStatus(harness.events)).toBe("idle")
    expect(agentStarts()).toBe(0)

    const prompting = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "again", session })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    calls[1]?.resolve()
    await prompting
    await vi.waitFor(() => expect(liveAgentText(harness.events)).toContain("prompt:again"))
  })

  it("sends nothing and starts no agent for a chat deleted during the download", async () => {
    const { harness, calls } = setup()

    const opening = harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId: session.conversationId })
    const before = harness.events.length
    calls[0]?.resolve()
    await opening

    expect(harness.events.slice(before).filter((event) => event.type !== "chat_status")).toEqual([])
    expect(agentStarts()).toBe(0)
  })
})
