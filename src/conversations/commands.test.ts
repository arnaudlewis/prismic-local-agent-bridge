import { describe, expect, it } from "vitest"

import { toBridgeCommand } from "./commands.ts"
import type { BridgeEvent } from "../protocol.ts"
import { windowId, session, createHarness, notices, promptedBlocks } from "../testing/harness.ts"

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


describe("blocked commands", () => {
  const blocked = ["logout", "review", "review-branch", "review-commit", "goal"]

  function promptedTexts(events: BridgeEvent[]): string[] {
    return promptedBlocks(events)
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


describe("blocked command canonicalization", () => {
  function promptedTexts(events: BridgeEvent[]): string[] {
    return promptedBlocks(events)
  }

  async function send(text: string) {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    harness.events.length = 0
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text, session })
    return harness
  }

  it.each([
    ["/ logout", "logout"],
    ["/\tgoal", "goal"],
    ["/\u00a0review", "review"],
    ["/\n review-branch", "review-branch"],
    ["/  LOGOUT", "logout"],
    [" /logout", "logout"],
    ["\u00a0/logout", "logout"],
    ["\ufeff/goal do something", "goal"],
    ["/\u2003review-commit abc", "review-commit"],
    ["/\u2028goal", "goal"],
    ["\n\n  /\t Review  ", "review"],
    ["/LoGoUt", "logout"],
  ])("rejects the bypass attempt %j without forwarding it", async (text, name) => {
    const harness = await send(text)

    expect(promptedTexts(harness.events)).toEqual([])
    expect(notices(harness.events)).toEqual([`The /${name} command isn't available in the local agent.`])
    expect(harness.events.at(-1)).toEqual({ type: "chat_status", status: "idle" })
  })

  it.each(["/status", "/ status", "/reviewer", "$skill", "//logout", "/logout2", "/etc/hosts", "please /logout"])(
    "still forwards %j",
    async (text) => {
      const harness = await send(text)

      expect(notices(harness.events)).toEqual([])
      expect(promptedTexts(harness.events)).toContain(text)
    },
  )

  it("sends a slash command as the first block, without the preamble", async () => {
    const harness = await send("/ status")

    expect(promptedTexts(harness.events)).toEqual(["/ status"])
  })
})
