import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createHarness, session, windowA } from "../testing/harness.ts"

const sessionMeta = { claudeCode: { options: { thinking: { type: "adaptive", display: "summarized" } } } }

let log = ""

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), "bridge-session-meta-")), "sessions.log")
  process.env.FAKE_AGENT_MCP_LOG = log
})

afterEach(() => {
  delete process.env.FAKE_AGENT_MCP_LOG
})

// What each session the fake agent was given carried in `_meta`, in order.
function metaGivenToAgents(): unknown[] {
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { meta?: unknown }).meta)
}

describe("the session meta of a provider", () => {
  it("is given to the agent when a session starts, and again when one is resumed", async () => {
    const first = createHarness({ providerOverrides: { sessionMeta: () => sessionMeta } })
    await first.agents.handleMessage(windowA, { type: "chat_open", session })
    await first.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })
    first.agents.stopAll()

    // A daemon restart: the conversation is on disk and the agent resumes it with session/load.
    const second = createHarness({ dataDir: first.dataDir, providerOverrides: { sessionMeta: () => sessionMeta } })
    await second.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(metaGivenToAgents()).toEqual([sessionMeta, sessionMeta])
  })

  it("is left out when the provider has none", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(metaGivenToAgents()).toEqual([undefined])
  })
})
