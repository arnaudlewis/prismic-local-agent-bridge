import { readFileSync, readdirSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createClaudeProvider } from "../agents/claude/claudeProvider.ts"
import { createApiKeyVault } from "../secrets/apiKeyVault.ts"
import { createMemorySecretStore } from "../testing/memorySecretStore.ts"
import type { BridgeEvent } from "../protocol.ts"
import { chatHistory, createHarness, fakeAgentBin, liveAgentText, notices, session, windowA, windowB } from "../testing/harness.ts"
import { createMessageRedactor, redactEvent, redactText, redactedMarker } from "./redaction.ts"

const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"
const other = "sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876"
const marker = "[redacted API key]"

describe("redactText", () => {
  it("replaces the exact secrets the daemon knows", () => {
    expect(redactText(`my key is ${key}, really`, [key])).toBe(`my key is ${marker}, really`)
    expect(redactText(`${key}${key}`, [key])).toBe(`${marker}${marker}`)
  })

  it("replaces anything shaped like an Anthropic key, known or not", () => {
    expect(redactText(`try ${other} and sk-ant-oat01-${"x".repeat(30)}`, [])).toBe(`try ${marker} and ${marker}`)
  })

  it("leaves ordinary text, short sk-ant- mentions and short secrets alone", () => {
    expect(redactText("keys start with sk-ant- and sk-ant-short", [])).toBe("keys start with sk-ant- and sk-ant-short")
    expect(redactText("abc and abc", ["abc"])).toBe("abc and abc")
    expect(redactText("", [key])).toBe("")
  })

  it("redacts every string of an event, at any depth, and keeps the rest", () => {
    const event = redactEvent(
      {
        type: "permission_request" as const,
        requestId: "r1",
        title: `Run with ${key}`,
        options: [{ optionId: "o", name: `allow ${key}`, kind: "allow_once" }],
      },
      [key],
    )

    expect(event).toEqual({
      type: "permission_request",
      requestId: "r1",
      title: `Run with ${marker}`,
      options: [{ optionId: "o", name: `allow ${marker}`, kind: "allow_once" }],
    })
  })
})

describe("message redactor (a key split across chunks)", () => {
  function run(chunks: string[], secrets: string[] = [key]): string {
    const redactor = createMessageRedactor()
    const out: string[] = []
    for (const chunk of chunks) for (const piece of redactor.push("m1", chunk, secrets)) out.push(piece.text)
    for (const piece of redactor.flushAll(secrets)) out.push(piece.text)
    return out.join("")
  }

  it.each([
    ["in the middle", [`the key is ${key.slice(0, 20)}`, `${key.slice(20)} thanks`]],
    ["after the first letter", ["the key is s", `${key.slice(1)} thanks`]],
    ["after the prefix", ["the key is sk-ant-", `${key.slice(7)} thanks`]],
    ["a character at a time", [..."the key is ", ...key, ..." thanks"]],
    ["in three pieces", [`the key is ${key.slice(0, 5)}`, key.slice(5, 30), `${key.slice(30)} thanks`]],
    ["with only its last character in the next chunk", [`the key is ${key.slice(0, -1)}`, `${key.slice(-1)} thanks`]],
  ])("is redacted when it is split %s", (_name, chunks) => {
    const text = run(chunks as string[])

    expect(text).toBe(`the key is ${marker} thanks`)
    expect(text).not.toContain("ABCDEF")
    expect(text).not.toContain("1234")
  })

  it("redacts a key that no exact secret covers, split in two", () => {
    expect(run([`use ${other.slice(0, 18)}`, `${other.slice(18)} now`], [])).toBe(`use ${marker} now`)
  })

  it("does not alter or delay ordinary text", () => {
    const redactor = createMessageRedactor()

    expect(redactor.push("m1", "hello world ", [key])).toEqual([{ messageId: "m1", text: "hello world " }])
    // An "s" could be the start of a key: it waits for the next chunk (or the end of the message).
    expect(redactor.push("m1", "and this ends in s", [key])).toEqual([{ messageId: "m1", text: "and this ends in " }])
    expect(redactor.flushAll([key])).toEqual([{ messageId: "m1", text: "s" }])
  })

  it("holds back only what could still become a key, and gives it back when it doesn't", () => {
    const redactor = createMessageRedactor()

    expect(redactor.push("m1", "an ask", [key])).toEqual([{ messageId: "m1", text: "an a" }])
    expect(redactor.push("m1", "ing for help", [key])).toEqual([{ messageId: "m1", text: "sking for help" }])
  })

  it("gives back a held tail that never became a key when the message ends", () => {
    const redactor = createMessageRedactor()
    redactor.push("m1", "see sk-", [key])

    expect(redactor.flushAll([key])).toEqual([{ messageId: "m1", text: "sk-" }])
  })

  it("redacts a long key prefix that never finished instead of releasing it", () => {
    const redactor = createMessageRedactor()
    redactor.push("m1", "leaked sk-ant-api03-ABCDEFGH", [])

    expect(redactor.flushAll([])).toEqual([{ messageId: "m1", text: marker }])
  })

  it("holds the tail of each message apart: another message neither releases it nor completes it", () => {
    const redactor = createMessageRedactor()
    redactor.push("m1", `the key is ${key.slice(0, 12)}`, [key])

    expect(redactor.push("m2", "second message", [key])).toEqual([{ messageId: "m2", text: "second message" }])
    expect(redactor.push("m2", key.slice(12), [key])).toEqual([{ messageId: "m2", text: key.slice(12) }])
    // A whole key at the end of a chunk is still held: the next character could extend it.
    expect(redactor.push("m1", key.slice(12), [key])).toEqual([])
    expect(redactor.push("m1", " thanks!", [key])).toEqual([{ messageId: "m1", text: `${marker} thanks!` }])
  })

  it("gives back the tails of every message at a boundary: a key prefix redacted whatever its length, other text as it is", () => {
    const redactor = createMessageRedactor()
    redactor.push("m1", "ends with sk-", [key])
    redactor.push("m2", "leaked sk-ant-api03-", [key])
    redactor.push("m3", "just sk-ant-", [key])

    expect(redactor.flushAll([key])).toEqual([
      { messageId: "m1", text: "sk-" },
      { messageId: "m2", text: marker },
      { messageId: "m3", text: marker },
    ])
    expect(redactor.flushAll([key])).toEqual([])
  })

  it("never holds more than a few unfinished messages: the oldest is released, redacted if it starts like a key", () => {
    const redactor = createMessageRedactor()
    const released: string[] = []
    for (let index = 0; index < 12; index++) {
      for (const piece of redactor.push(`m${index}`, "text sk-ant-api03-", [key])) released.push(piece.text)
    }

    expect(released.filter((text) => text === marker)).toHaveLength(4)
    expect(released.join("")).not.toContain("sk-ant")
  })
})

beforeEach(() => {
  process.env.FAKE_AGENT_MODE_VALUES = "default,plan"
})

afterEach(() => {
  delete process.env.FAKE_AGENT_MODE_VALUES
})

const claudeSession = { ...session, agent: "claude" as const }
const channel = `${windowA}/claude`

function setup() {
  const store = createMemorySecretStore(key)
  const vault = createApiKeyVault({ store, env: () => undefined })
  const provider = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault, userClaudeHome: "/tmp", agentBin: fakeAgentBin })
  return { harness: createHarness({ providers: [provider] }), vault }
}

function everything(events: BridgeEvent[]): string {
  return JSON.stringify(events)
}

function storedFiles(dataDir: string): string {
  const dir = `${dataDir}/conversations`
  return readdirSync(dir).map((name) => readFileSync(`${dir}/${name}`, "utf8")).join("\n")
}

describe("the API key in what an agent says", () => {
  async function open(harness: ReturnType<typeof setup>["harness"]) {
    await harness.agents.handleMessage(channel, { type: "chat_open", session: claudeSession })
    harness.events.length = 0
  }

  it("is replaced in the text sent to the browser, the history and the files", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `say-chunks m1 the key is ${key} ok`, session: claudeSession })

    expect(liveAgentText(harness.events)).toBe(`the key is ${marker} ok`)
    harness.agents.stopAll()
    expect(everything(harness.events)).not.toContain(key)
    expect(storedFiles(harness.dataDir)).not.toContain(key)
  })

  it("is replaced when it is split across the chunks of one message, live and stored", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, {
      type: "chat_prompt",
      text: `say-chunks m1 the key is ${key.slice(0, 15)}|${key.slice(15, 31)}|${key.slice(31)} thanks`,
      session: claudeSession,
    })

    const live = liveAgentText(harness.events)
    expect(live).toBe(`the key is ${marker} thanks`)
    await harness.agents.handleMessage(`${windowB}/claude`, { type: "chat_open", session: claudeSession })
    const history = chatHistory(harness.eventsFor(`${windowB}/claude`))
    const replayed = history.flatMap((event) => (event.type === "agent_message_chunk" ? [event.text] : [])).join("")
    expect(replayed).toBe(`the key is ${marker} thanks`)
    harness.agents.stopAll()
    expect(storedFiles(harness.dataDir)).not.toContain(key.slice(10, 30))
    expect(everything(harness.events)).not.toContain(key.slice(10, 30))
  })

  it("still shows the text before and after a split key, in order, as one message", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `say-chunks m1 before |${key.slice(0, 9)}|${key.slice(9)}| after`, session: claudeSession })

    expect(liveAgentText(harness.events)).toBe(`before ${marker} after`)
    const chunks = harness.events.filter((event) => event.type === "agent_message_chunk")
    expect(new Set(chunks.map((event) => (event.type === "agent_message_chunk" ? event.messageId : undefined)))).toEqual(new Set(["m1"]))
  })

  it("is replaced in tool call titles and updates, notices and permission requests", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `emit-claude-tool prismic leak_${key}_tool {}`, session: claudeSession })
    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `fail-prompt oops ${key}`, session: claudeSession })

    const text = everything(harness.events)
    expect(text).not.toContain(key)
    expect(text).toContain(marker)
    expect(notices(harness.events).join(" ")).not.toContain(key)
  })

  it("is replaced in a permission request and in the transcript of what was approved", async () => {
    const { harness } = setup()
    await open(harness)
    const turn = harness.agents.handleMessage(channel, { type: "chat_prompt", text: "ask-permission-with-key", session: claudeSession })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const request = harness.events.find((event) => event.type === "permission_request")
    expect(JSON.stringify(request)).not.toContain(key)
    expect(JSON.stringify(request)).toContain(marker)
    await harness.agents.handleMessage(channel, { type: "chat_cancel" })
    await turn
  })

  it("is replaced in the user's own message, the thread title and the index", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `here is my key ${key} please use it`, session: claudeSession })
    await harness.agents.handleMessage(channel, { type: "threads_list", repository: "repo", agent: "claude" })

    const threads = harness.events.findLast((event) => event.type === "threads")
    expect(threads?.type === "threads" && threads.threads[0]?.title).toBe(`here is my key ${marker} please use it`)
    harness.agents.stopAll()
    const dir = `${harness.dataDir}/conversations`
    for (const name of readdirSync(dir)) expect(readFileSync(`${dir}/${name}`, "utf8")).not.toContain(key)
    expect(everything(harness.events)).not.toContain(key)
  })

  it("covers a key the daemon knew earlier and has since replaced", async () => {
    const { harness, vault } = setup()
    await open(harness)
    await vault.set(other)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `say-chunks m1 old ${key} new ${other}`, session: claudeSession })

    expect(liveAgentText(harness.events)).toBe(`old ${marker} new ${marker}`)
  })

  it("covers another agent's conversation too: a Codex reply can't leak the Claude key", async () => {
    const store = createMemorySecretStore(key)
    const vault = createApiKeyVault({ store, env: () => undefined })
    await vault.get()
    const claude = createClaudeProvider({ dataDir: "/tmp/bridge-claude-fake", vault, userClaudeHome: "/tmp", agentBin: fakeAgentBin })
    const probe = createHarness({ providers: [claude] })
    // A conversation of the Claude provider that is asked to repeat the key as someone else's text.
    await probe.agents.handleMessage(channel, { type: "chat_open", session: claudeSession })
    probe.events.length = 0

    await probe.agents.handleMessage(channel, { type: "chat_prompt", text: `say-chunks m1 ${key}`, session: claudeSession })

    expect(everything(probe.events)).not.toContain(key)
  })

  it("does not change what the agent itself received", async () => {
    const { harness } = setup()
    await open(harness)

    await harness.agents.handleMessage(channel, { type: "chat_prompt", text: "env-tail ANTHROPIC_API_KEY", session: claudeSession })

    expect(liveAgentText(harness.events)).toBe(`envtail:ANTHROPIC_API_KEY=${key.slice(-4)}`)
  })

  describe("when other events of the turn arrive in the middle of a message", () => {
    // What the agent said, as the stored conversation has it (the user's own message has the script, not the key).
    function storedAgentText(harness: ReturnType<typeof setup>["harness"]): string {
      harness.agents.stopAll()
      const dir = `${harness.dataDir}/conversations`
      return readdirSync(dir)
        .filter((name) => name !== "index.json")
        .flatMap((name) => (JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as { events: { type: string; text?: string }[] }).events)
        .flatMap((event) => (event.type === "agent_message_chunk" ? [event.text ?? ""] : []))
        .join("")
    }

    it.each([
      ["inside the prefix", `the key is sk-an|@tool|t-${key.slice(7)} thanks!`],
      ["right after the prefix", `the key is sk-ant-|@tool|${key.slice(7)} thanks!`],
      ["after sk-ant-api03-", `the key is sk-ant-api03-|@tool|${key.slice(13)} thanks!`],
      ["after its first letter", `the key is s|@tool|${key.slice(1)} thanks!`],
      ["several times", `the key is sk-ant-|@tool|api03-|@tool|${key.slice(13, 20)}|@tool|${key.slice(20)} thanks!`],
    ])("does not release the pieces of a key split %s", async (_name, script) => {
      const { harness } = setup()
      await open(harness)

      await harness.agents.handleMessage(channel, { type: "chat_prompt", text: `say-chunks m1 ${script}`, session: claudeSession })

      expect(liveAgentText(harness.events)).toBe(`the key is ${marker} thanks!`)
      expect(storedAgentText(harness)).toBe(`the key is ${marker} thanks!`)
    })

    it("keeps the interleaved events, and the text around them in order", async () => {
      const { harness } = setup()
      await open(harness)

      await harness.agents.handleMessage(channel, { type: "chat_prompt", text: "say-chunks m1 before |@tool| after", session: claudeSession })

      expect(harness.events.filter((event) => event.type === "tool_call")).toHaveLength(1)
      expect(liveAgentText(harness.events)).toBe("before  after")
    })

    it("redacts a key prefix that was never completed when the turn ends, and keeps an ordinary tail", async () => {
      const { harness } = setup()
      await open(harness)

      await harness.agents.handleMessage(channel, { type: "chat_prompt", text: "say-chunks m1 leaked sk-ant-api03-", session: claudeSession })
      expect(liveAgentText(harness.events)).toBe(`leaked ${marker}`)

      harness.events.length = 0
      await harness.agents.handleMessage(channel, { type: "chat_prompt", text: "say-chunks m2 the answer is yes, as always ends with s", session: claudeSession })
      expect(liveAgentText(harness.events)).toBe("the answer is yes, as always ends with s")
      expect(harness.events.findLast((event) => event.type === "turn_end")).toBeDefined()
    })

    it("says what a stopped agent was still holding, redacted when it starts like a key", async () => {
      const { harness } = setup()
      await open(harness)
      // The held turn never ends; the agent is stopped (the conversation deleted) with a tail still held.
      const turn = harness.agents.handleMessage(channel, { type: "chat_prompt", text: "hold-after-chunks m1 so sk-ant-api03-", session: claudeSession })
      await new Promise((resolve) => setTimeout(resolve, 400))

      harness.agents.stopAll()
      await turn.catch(() => {})

      expect(liveAgentText(harness.events)).toBe(`so ${marker}`)
    })
  })
})
