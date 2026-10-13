import { existsSync, readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BridgeEvent } from "../protocol.ts"
import { chatHistory, conversationFile, conversationId, createHarness, lastStatus, liveAgentText, pause, session, thoughtText, windowA, windowB } from "../testing/harness.ts"
import type { Harness } from "../testing/harness.ts"
import { maxThoughtBytesPerTurn } from "./output.ts"
import { redactedMarker } from "./redaction.ts"

const reasoning = { ...session, showReasoning: true }
const notReasoning = { ...session, showReasoning: false }

const oauthToken = "oauth-access-token-0123456789abcdef"
const anthropicKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"

beforeEach(() => {
  process.env.FAKE_AGENT_THOUGHTS = "first|second"
})

afterEach(() => {
  delete process.env.FAKE_AGENT_THOUGHTS
  delete process.env.FAKE_AGENT_THOUGHT_ID
  delete process.env.FAKE_AGENT_INIT_DELAY_MS
  delete process.env.FAKE_AGENT_THOUGHT_DELAY_MS
  delete process.env.FAKE_AGENT_THOUGHT_REPEAT
})

function thoughts(events: BridgeEvent[]) {
  return events.filter((event) => event.type === "agent_thought_chunk")
}

function statuses(events: BridgeEvent[]) {
  return events.filter((event) => event.type === "chat_status")
}

describe("the agent's reasoning", () => {
  it("reaches the window as agent_thought_chunk events when the session asks for it", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: reasoning })

    expect(thoughts(harness.eventsFor(windowA))).toEqual([
      { type: "agent_thought_chunk", text: "first", messageId: "thought-1" },
      { type: "agent_thought_chunk", text: "second", messageId: "thought-1" },
    ])
    expect(liveAgentText(harness.eventsFor(windowA))).toContain("prompt:hi")
  })

  it("is not sent when the session doesn't ask for it, and the agent's reply still arrives", async () => {
    for (const asking of [session, notReasoning]) {
      const harness = createHarness()
      await harness.agents.handleMessage(windowA, { type: "chat_open", session: asking })

      await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: asking })

      expect(thoughts(harness.events)).toEqual([])
      expect(JSON.stringify(harness.events)).not.toContain("agent_thought_chunk")
      expect(liveAgentText(harness.eventsFor(windowA))).toContain("prompt:hi")
      expect(harness.eventsFor(windowA).some((event) => event.type === "turn_end")).toBe(true)
    }
  })

  it("follows the session of each chat_prompt, for the turn it starts", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const seen: string[] = []
    async function turn(text: string, asking: typeof session) {
      const from = harness.eventsFor(windowA).length
      await harness.agents.handleMessage(windowA, { type: "chat_prompt", text, session: asking })
      seen.push(thoughtText(harness.eventsFor(windowA).slice(from)))
    }

    await turn("one", session)
    await turn("two", reasoning)
    await turn("three", notReasoning)
    await turn("four", reasoning)
    await turn("five", session)

    expect(seen).toEqual(["", "firstsecond", "", "firstsecond", ""])
  })

  it("is turned on and off by chat_open as well", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: reasoning })
    expect(thoughtText(harness.eventsFor(windowA))).toBe("firstsecond")

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: notReasoning })
    const from = harness.eventsFor(windowA).length
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "again", session: notReasoning })
    expect(thoughtText(harness.eventsFor(windowA).slice(from))).toBe("")
  })

  it("goes only to the window the conversation is attached to", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    await harness.agents.handleMessage(windowB, { type: "chat_open", session: reasoning })

    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "hi", session: reasoning })

    expect(thoughtText(harness.eventsFor(windowB))).toBe("firstsecond")
    expect(thoughtText(harness.eventsFor(windowA))).toBe("")
  })
})

describe("the agent's reasoning is never kept", () => {
  it("is not in the conversation file, the history of a new window or what is reloaded from disk", async () => {
    process.env.FAKE_AGENT_THOUGHTS = "pondering-alpha|pondering-beta"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: reasoning })
    expect(thoughtText(harness.eventsFor(windowA))).toBe("pondering-alphapondering-beta")

    const onDisk = readFileSync(conversationFile(harness), "utf8")
    expect(onDisk).toContain("prompt:hi")
    expect(onDisk).not.toContain("pondering")
    expect(onDisk).not.toContain("agent_thought_chunk")

    harness.agents.detachWindow(windowA)
    await harness.agents.handleMessage(windowB, { type: "chat_open", session: reasoning })
    const history = chatHistory(harness.eventsFor(windowB))
    expect(history.length).toBeGreaterThan(0)
    expect(JSON.stringify(history)).not.toContain("pondering")
    expect(JSON.stringify(history)).not.toContain("agent_thought_chunk")
    expect(thoughtText(harness.eventsFor(windowB))).toBe("")

    harness.agents.stopAll()
    expect(readFileSync(conversationFile(harness), "utf8")).not.toContain("pondering")
    const reloaded = createHarness({ dataDir: harness.dataDir })
    await reloaded.agents.handleMessage(windowB, { type: "chat_open", session: reasoning })
    expect(JSON.stringify(chatHistory(reloaded.eventsFor(windowB)))).toContain("prompt:hi")
    expect(JSON.stringify(reloaded.eventsFor(windowB))).not.toContain("pondering")
  })
})

describe("the secrets in the agent's reasoning", () => {
  async function think(pieces: string, options: { harness?: Harness; messageId?: string } = {}) {
    process.env.FAKE_AGENT_THOUGHTS = pieces
    if (options.messageId !== undefined) process.env.FAKE_AGENT_THOUGHT_ID = options.messageId
    const harness = options.harness ?? createHarness({ prismicAccessToken: oauthToken })
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: reasoning })
    return { harness, events: harness.eventsFor(windowA) }
  }

  it("redacts a secret the daemon knows", async () => {
    const { events } = await think(`using ${oauthToken} ok`)

    expect(thoughtText(events)).toBe(`using ${redactedMarker} ok`)
    expect(JSON.stringify(thoughts(events))).not.toContain("0123456789abcdef")
  })

  it("redacts a secret that is split across two chunks of the same message", async () => {
    const { events } = await think(`before ${oauthToken.slice(0, 12)}|${oauthToken.slice(12)} after`)

    expect(thoughtText(events)).toBe(`before ${redactedMarker} after`)
    const sent = JSON.stringify(thoughts(events))
    expect(sent).not.toContain("0123456789abcdef")
    expect(sent).not.toContain("oauth-access")
  })

  it("redacts a key shaped like an Anthropic key, also when it is split", async () => {
    const { events } = await think(`use ${anthropicKey.slice(0, 15)}|${anthropicKey.slice(15, 31)}|${anthropicKey.slice(31)} now`)

    expect(thoughtText(events)).toBe(`use ${redactedMarker} now`)
    expect(JSON.stringify(thoughts(events))).not.toContain("ABCDEF")
  })

  it.each([
    ["a key prefix that never finished", "leaked sk-ant-api03-ABCDEFGH", `leaked ${redactedMarker}`],
    ["a bare key prefix", "leaked sk-ant-", `leaked ${redactedMarker}`],
    ["an ordinary tail", "the answer is yes, as always ends with s", "the answer is yes, as always ends with s"],
  ])("flushes what it was holding when the turn ends: %s", async (_name, written, expected) => {
    const { events } = await think(written)

    expect(thoughtText(events)).toBe(expected)
    const lastThought = events.findLastIndex((event) => event.type === "agent_thought_chunk")
    expect(lastThought).toBeGreaterThan(-1)
    expect(lastThought).toBeLessThan(events.findIndex((event) => event.type === "turn_end"))
  })

  it("holds its tails apart from the messages' ones, even with the same message id", async () => {
    process.env.FAKE_AGENT_THOUGHTS = "leaked sk-ant-api03-"
    process.env.FAKE_AGENT_THOUGHT_ID = "m1"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "say-chunks m1 hello", session: reasoning })

    expect(liveAgentText(harness.eventsFor(windowA))).toBe("hello")
    expect(thoughtText(harness.eventsFor(windowA))).toBe(`leaked ${redactedMarker}`)
  })
})

describe("stopping a turn that was thinking", () => {
  it("says what was held, redacted, once when the conversation is deleted, and nothing after", async () => {
    process.env.FAKE_AGENT_THOUGHTS = "reasoning about sk-ant-api03-"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session: reasoning })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    expect(thoughtText(harness.eventsFor(windowA))).toBe("reasoning about ")

    await harness.agents.handleMessage(windowA, { type: "chat_delete", conversationId })
    await turn

    expect(thoughtText(harness.eventsFor(windowA))).toBe(`reasoning about ${redactedMarker}`)
    const sent = harness.eventsFor(windowA).length
    await pause(500)
    expect(harness.eventsFor(windowA)).toHaveLength(sent)
    expect(existsSync(conversationFile(harness))).toBe(false)

    // The same id starts again from scratch: nothing of the old turn is left to come out of it.
    process.env.FAKE_AGENT_THOUGHTS = "fresh start"
    await harness.agents.handleMessage(windowB, { type: "chat_open", session: reasoning })
    await harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "hello", session: reasoning })

    expect(thoughtText(harness.eventsFor(windowB))).toBe("fresh start")
    expect(harness.eventsFor(windowA)).toHaveLength(sent)
  })

  it("says what was held when the agent is stopped, and sends nothing for a cancelled turn afterwards", async () => {
    process.env.FAKE_AGENT_THOUGHTS = "so sk-ant-api03-"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session: reasoning })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))

    await harness.agents.handleMessage(windowA, { type: "chat_cancel" })
    await turn

    expect(thoughtText(harness.eventsFor(windowA))).toBe(`so ${redactedMarker}`)
    expect(harness.eventsFor(windowA)).toContainEqual({ type: "turn_end", stopReason: "cancelled" })
  })
})

describe("the setting changing in the middle of a turn", () => {
  // The page can change showReasoning on any chat_open: what the agent thought before that is still what the
  // redactor has to know, or the end of a key that began while nobody was looking would come out whole.
  it.each([
    ["with a message id", "thought-1"],
    ["without a message id", "none"],
  ])("never shows the end of a key whose beginning was thought while it was off, %s", async (_name, messageId) => {
    process.env.FAKE_AGENT_THOUGHTS = "leaked sk-ant-|api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 done"
    process.env.FAKE_AGENT_THOUGHT_ID = messageId
    process.env.FAKE_AGENT_THOUGHT_DELAY_MS = "800"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: notReasoning })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "think-slowly", session: notReasoning })
    await vi.waitFor(() => expect(lastStatus(harness.eventsFor(windowA))).toBe("running"))
    await pause(250)

    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    await turn

    const text = thoughtText(harness.eventsFor(windowA))
    expect(text).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")
    expect(text).not.toContain("api03-")
    expect(text).toBe(`${redactedMarker} done`)
    expect(liveAgentText(harness.eventsFor(windowA))).toContain("slow-reply")
  })

  it.each([
    ["the same window", windowA, "cancel"],
    ["the same window", windowA, "delete"],
    ["the same window", windowA, "stopAll"],
    ["a second window", windowB, "cancel"],
  ] as const)("sends no held thought to %s that no longer asks for them, when the turn ends by %s", async (_name, asking, end) => {
    process.env.FAKE_AGENT_THOUGHTS = "so sk-ant-"
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session: reasoning })
    await vi.waitFor(() => expect(liveAgentText(harness.eventsFor(windowA))).toContain("working"))
    expect(thoughtText(harness.eventsFor(windowA))).toBe("so ")

    await harness.agents.handleMessage(asking, { type: "chat_open", session: notReasoning })
    if (end === "cancel") await harness.agents.handleMessage(asking, { type: "chat_cancel" })
    if (end === "delete") await harness.agents.handleMessage(asking, { type: "chat_delete", conversationId })
    if (end === "stopAll") harness.agents.stopAll()
    await turn.catch(() => {})
    await pause(200)

    expect(thoughtText(harness.eventsFor(windowA))).toBe("so ")
    expect(thoughtText(harness.eventsFor(windowB))).toBe("")
    expect(JSON.stringify(harness.events)).not.toContain("sk-ant")
  })
})

describe("the budget of reasoning per turn", () => {
  const chunkSize = 1024
  const bytesOf = (events: BridgeEvent[]) => Buffer.byteLength(thoughtText(events))

  it("stops sending reasoning past it, keeps the reply and the end of the turn, and starts again on the next turn", async () => {
    process.env.FAKE_AGENT_THOUGHTS = `@pad:${chunkSize}`
    process.env.FAKE_AGENT_THOUGHT_REPEAT = String(Math.ceil((maxThoughtBytesPerTurn * 1.5) / chunkSize))
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })
    const sentBytes: number[] = []

    for (const text of ["one", "two"]) {
      const from = harness.eventsFor(windowA).length
      await harness.agents.handleMessage(windowA, { type: "chat_prompt", text, session: reasoning })
      const events = harness.eventsFor(windowA).slice(from)
      sentBytes.push(bytesOf(events))
      expect(liveAgentText(events)).toContain(`prompt:${text}`)
      expect(events.some((event) => event.type === "turn_end")).toBe(true)
    }

    for (const sent of sentBytes) {
      expect(sent).toBeGreaterThanOrEqual(maxThoughtBytesPerTurn)
      expect(sent).toBeLessThanOrEqual(maxThoughtBytesPerTurn + chunkSize)
    }
  })

  it("keeps a secret that straddles the budget from ever being shown", async () => {
    // The budget is reached just before the key: what the redactor holds of it, and then the rest of the stream, is dropped.
    process.env.FAKE_AGENT_THOUGHTS = `@pad:${maxThoughtBytesPerTurn - 4}|ends with sk-ant-api03-ABCDEFGH|IJKLMNOPQRSTUVWXYZ1234 more|@pad:100|sk-ant-api03-ZYXWVUTSRQP|ONMLKJIHGFEDCBA9876 end`
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session: reasoning })

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session: reasoning })

    const sent = JSON.stringify(thoughts(harness.eventsFor(windowA)))
    for (const fragment of ["ABCDEFGH", "IJKLMNOP", "api03", "ZYXWVUTS", "ONMLKJIH", "9876"]) expect(sent).not.toContain(fragment)
    expect(bytesOf(harness.eventsFor(windowA))).toBeLessThanOrEqual(maxThoughtBytesPerTurn + 1024)
    expect(liveAgentText(harness.eventsFor(windowA))).toContain("prompt:hi")
  })
})

describe("the busy clock", () => {
  // The daemon's clock stands still until a test moves it; processes and sockets keep running in real time.
  const start = 1_000_000
  let now = start

  beforeEach(() => {
    now = start
    vi.spyOn(Date, "now").mockImplementation(() => now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setNow(value: number) {
    now = value
  }

  it("gives elapsedMs to starting and running, and none to idle", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })

    expect(statuses(harness.eventsFor(windowA))).toEqual([{ type: "chat_status", status: "starting", elapsedMs: 0 }, { type: "chat_status", status: "idle" }])

    await harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hi", session })

    const sent = statuses(harness.eventsFor(windowA)).slice(2)
    expect(sent).toEqual([
      { type: "chat_status", status: "starting", elapsedMs: 0 },
      { type: "chat_status", status: "running", elapsedMs: 0 },
      { type: "chat_status", status: "idle" },
    ])
    expect(Object.keys(sent[2] ?? {})).toEqual(["type", "status"])
  })

  it("keeps counting from starting to running", async () => {
    process.env.FAKE_AGENT_INIT_DELAY_MS = "400"
    const harness = createHarness()
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(lastStatus(harness.eventsFor(windowA))).toBe("starting"))

    setNow(start + 2000)
    await vi.waitFor(() => expect(lastStatus(harness.eventsFor(windowA))).toBe("running"))

    expect(statuses(harness.eventsFor(windowA))).toEqual([
      { type: "chat_status", status: "starting", elapsedMs: 0 },
      { type: "chat_status", status: "running", elapsedMs: 2000 },
    ])
    await harness.agents.handleMessage(windowA, { type: "chat_cancel" })
    await turn
  })

  it("is not reset by a window that attaches while the turn runs (a page reload), and starts again after idle", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    const turn = harness.agents.handleMessage(windowA, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(lastStatus(harness.eventsFor(windowA))).toBe("running"))

    setNow(start + 5000)
    harness.agents.detachWindow(windowA)
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })

    expect(statuses(harness.eventsFor(windowB))).toEqual([
      { type: "chat_status", status: "running", elapsedMs: 5000 },
      { type: "chat_status", status: "running", elapsedMs: 5000 },
    ])

    // A second chat_open of the same window changes nothing either.
    setNow(start + 6000)
    await harness.agents.handleMessage(windowB, { type: "chat_open", session })
    expect(statuses(harness.eventsFor(windowB)).at(-1)).toEqual({ type: "chat_status", status: "running", elapsedMs: 6000 })

    await harness.agents.handleMessage(windowB, { type: "chat_cancel" })
    await turn
    expect(statuses(harness.eventsFor(windowB)).at(-1)).toEqual({ type: "chat_status", status: "idle" })

    // The next turn counts from its own start.
    setNow(start + 100_000)
    const next = harness.agents.handleMessage(windowB, { type: "chat_prompt", text: "hold on", session })
    await vi.waitFor(() => expect(lastStatus(harness.eventsFor(windowB))).toBe("running"))
    const nextStatuses = statuses(harness.eventsFor(windowB)).slice(-2)
    expect(nextStatuses).toEqual([
      { type: "chat_status", status: "starting", elapsedMs: 0 },
      { type: "chat_status", status: "running", elapsedMs: 0 },
    ])

    setNow(start + 100_700)
    harness.agents.detachWindow(windowB)
    await harness.agents.handleMessage(windowA, { type: "chat_open", session })
    expect(statuses(harness.eventsFor(windowA)).at(-1)).toEqual({ type: "chat_status", status: "running", elapsedMs: 700 })

    await harness.agents.handleMessage(windowA, { type: "chat_cancel" })
    await next
  })
})
