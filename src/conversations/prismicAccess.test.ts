import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { conversationId, createHarness, lastStatus, liveAgentText, notices, session, windowA } from "../testing/harness.ts"

const oauthAccessToken = "oauth-access-token-the-agent-must-never-see"
const notConnectedNotice = "This window isn't connected. Connect again from the agent panel."
const signInNotice = "Sign in to Prismic again from the agent panel."

let mcpLog = ""

beforeEach(() => {
  mcpLog = join(mkdtempSync(join(tmpdir(), "bridge-prismic-access-")), "mcp.log")
  process.env.FAKE_AGENT_MCP_LOG = mcpLog
})

afterEach(() => {
  delete process.env.FAKE_AGENT_MCP_LOG
  delete process.env.FAKE_AGENT_NEW_SESSION_DELAY_MS
  delete process.env.FAKE_AGENT_EXIT_ON_NEW_SESSION
})

// One entry per session the fake agent was given: the MCP server it was told to use.
function givenToAgents(): Array<{ url: string; authorization: string }> {
  if (!existsSync(mcpLog)) return []
  return readFileSync(mcpLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { url: string; authorization: string })
}

function grantOf(entry: { authorization: string } | undefined): string {
  return entry?.authorization.replace("Bearer ", "") ?? ""
}

describe("what an agent is given to reach Prismic", () => {
  it("is the daemon's MCP proxy and a token of its own, never the OAuth access token", async () => {
    const harness = createHarness({ prismicAccessToken: oauthAccessToken })

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    const [given] = givenToAgents()
    expect(given?.url).toBe(`http://127.0.0.1:${harness.prismic.runtime.bridgePort}/agent-mcp`)
    const grant = grantOf(given)
    expect(grant).not.toBe("")
    expect(given?.authorization).not.toContain(oauthAccessToken)
    expect(harness.prismic.runtime.grants.resolve(grant)).toEqual({ mcpOrigin: "http://127.0.0.1:1", windowKey: windowA, userId: "user-1" })
  })

  it("stops working when the agent is stopped", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const grant = grantOf(givenToAgents()[0])
    expect(harness.prismic.runtime.grants.resolve(grant)).toBeDefined()

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })

    expect(harness.prismic.runtime.grants.resolve(grant)).toBeUndefined()
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])
  })

  it("is not renewed when the OAuth token is refreshed or the same account signs in again, but is when another account signs in", async () => {
    const harness = createHarness()
    const { grants } = harness.prismic.runtime
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const firstGrant = grantOf(givenToAgents()[0])

    harness.prismic.setAccessToken("refreshed-access-token")
    harness.prismic.setUserId("user-1")
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    expect(givenToAgents()).toHaveLength(1)
    expect(grants.resolve(firstGrant)).toBeDefined()

    harness.prismic.setUserId("someone-else")
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    const all = givenToAgents()
    expect(all).toHaveLength(2)
    const secondGrant = grantOf(all[1])
    expect(secondGrant).not.toBe(firstGrant)
    // The restarted agent must not be able to keep using the previous account's proxy token.
    expect(grants.resolve(firstGrant)).toBeUndefined()
    expect(grants.resolve(secondGrant)).toBeDefined()
    expect(grants.tokens()).toEqual([secondGrant])
  })
})

describe("a window the agent cannot be started for", () => {
  it("is told it isn't connected when no MCP origin is known for it, and no agent starts", async () => {
    const harness = createHarness({ mcpOrigin: undefined })

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })

    expect(notices(harness.events)).toEqual([notConnectedNotice, notConnectedNotice])
    expect(lastStatus(harness.events)).toBe("idle")
    expect(liveAgentText(harness.events)).toBe("")
    expect(givenToAgents()).toEqual([])
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])
  })

  it("is asked to sign in to Prismic when the daemon is signed out, and works once it is signed in again", async () => {
    const harness = createHarness()
    harness.prismic.setUserId(undefined)

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello", session })

    expect(notices(harness.events)).toEqual([signInNotice])
    expect(lastStatus(harness.events)).toBe("idle")
    expect(liveAgentText(harness.events)).toBe("")
    expect(givenToAgents()).toEqual([])
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])

    harness.prismic.setUserId("user-1")
    harness.events.length = 0
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hello again", session })

    expect(notices(harness.events)).toEqual([])
    expect(liveAgentText(harness.events)).toContain("prompt:hello again")
    expect(givenToAgents()).toHaveLength(1)
  })
})

describe("an agent that is still starting", () => {
  // The fake agent has logged its MCP config (so it holds its grant) and then stalls, ignoring SIGTERM.
  async function openStallingAgent() {
    process.env.FAKE_AGENT_NEW_SESSION_DELAY_MS = "1500"
    const harness = createHarness()
    const opening = harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await vi.waitFor(() => expect(givenToAgents()).toHaveLength(1))
    const grant = grantOf(givenToAgents()[0])
    expect(harness.prismic.runtime.grants.resolve(grant)).toBeDefined()
    return { harness, grant, opening }
  }

  it("has its grant revoked at once when the conversation is deleted, even though the process ignores SIGTERM", async () => {
    const { harness, grant, opening } = await openStallingAgent()

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })

    expect(harness.prismic.runtime.grants.resolve(grant)).toBeUndefined()
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])
    await opening
  })

  it("has its grant revoked at once when the daemon stops everything", async () => {
    const { harness, grant, opening } = await openStallingAgent()

    harness.agents.stopAll()

    expect(harness.prismic.runtime.grants.resolve(grant)).toBeUndefined()
    await opening
  })

  it("leaves no live grant when the agent dies during the handshake", async () => {
    process.env.FAKE_AGENT_EXIT_ON_NEW_SESSION = "1"
    const harness = createHarness()

    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(givenToAgents()).toHaveLength(1)
    expect(notices(harness.events)).toHaveLength(1)
    expect(notices(harness.events)[0]).toContain("Couldn't start the local agent")
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])
  })
})

describe("a start queued behind another one", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const stallMs = 1200

  // The first start is held in its handshake; a chat_open and a chat_prompt for the same conversation queue behind it.
  async function queueBehindStall() {
    process.env.FAKE_AGENT_NEW_SESSION_DELAY_MS = String(stallMs)
    const harness = createHarness()
    const first = harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await vi.waitFor(() => expect(givenToAgents()).toHaveLength(1))
    const queued = [
      harness.agents.handleMessage(windowA, { type: "chat_open", session }),
      harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "queued prompt", session }),
    ]
    return { harness, pending: [first, ...queued] }
  }

  // `detached`: the window was detached by the delete, so nothing at all reaches it. After stopAll the window is still
  // attached to the stopped conversation, which may be told it is idle: nothing else may reach it.
  async function expectNothingStartedAfterRelease(
    harness: ReturnType<typeof createHarness>,
    pending: Promise<void>[],
    detached: boolean,
  ) {
    harness.events.length = 0
    await Promise.all(pending)
    // Long enough for a second child to be spawned and to log its MCP config, were it spawned.
    await pause(stallMs + 600)

    expect(givenToAgents()).toHaveLength(1)
    expect(harness.prismic.runtime.grants.tokens()).toEqual([])
    expect(liveAgentText(harness.events)).toBe("")
    expect(harness.events.filter((event) => event.type !== "chat_status" || event.status !== "idle")).toEqual([])
    if (detached) expect(harness.events).toEqual([])
  }

  it("does not spawn an agent or issue a grant for a conversation deleted while it waited", async () => {
    const { harness, pending } = await queueBehindStall()

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })

    await expectNothingStartedAfterRelease(harness, pending, true)
  })

  it("does not spawn an agent or issue a grant after the daemon stopped everything while it waited", async () => {
    const { harness, pending } = await queueBehindStall()

    harness.agents.stopAll()

    await expectNothingStartedAfterRelease(harness, pending, false)
  })
})
