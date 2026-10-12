import { describe, expect, it } from "vitest"

import type { BridgeConfigOption, Session } from "../protocol.ts"
import { windowId, conversationId, session, createHarness, notices } from "../testing/harness.ts"
import type { Harness } from "../testing/harness.ts"

describe("full access", () => {
  it("offers agent-full-access in session_config and accepts selecting it", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.values.map((entry) => entry.value)).toEqual([
      "read-only",
      "workspace-write",
      "agent",
      "agent-full-access",
    ])

    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "mode",
      value: "agent-full-access",
    })

    expect(notices(harness.events)).toEqual([])
    expect(harness.lastMode()?.currentValue).toBe("agent-full-access")
  })

  it("still allows other modes", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "set_config_option", configId: "mode", value: "agent" })

    expect(notices(harness.events)).toEqual([])
    expect(harness.lastMode()?.currentValue).toBe("agent")
  })

  it("starts a new conversation in the default mode, and keeps the mode per conversation", async () => {
    const harness = createHarness()
    const other: Session = { ...session, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "mode",
      value: "agent-full-access",
    })

    await harness.agents.handleMessage(windowId, { type: "chat_open", session: other })
    expect(harness.lastMode()?.currentValue).toBe("read-only")

    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.currentValue).toBe("agent-full-access")
  })
})

describe("preferredConfig", () => {
  it("never changes the mode at chat_open", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, {
      type: "chat_open",
      session,
      preferredConfig: { mode: "agent-full-access" },
    })

    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })

  it("keeps the mode chosen with set_config_option across an agent restart, and not for another conversation", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, { type: "set_config_option", configId: "mode", value: "agent" })

    harness.prismic.setUserId("other")
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(harness.lastMode()?.currentValue).toBe("agent")

    await harness.agents.handleMessage(windowId, {
      type: "chat_open",
      session: { ...session, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    })
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
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

  it("accepts set_config_option, keeps it across an agent restart and starts a new conversation on the default", async () => {
    const harness = createHarness()
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    await harness.agents.handleMessage(windowId, {
      type: "set_config_option",
      configId: "collaboration_mode",
      value: "plan",
    })
    expect(notices(harness.events)).toEqual([])
    expect(lastOption(harness, "collaboration_mode")?.currentValue).toBe("plan")

    harness.prismic.setUserId("other")
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })
    expect(lastOption(harness, "collaboration_mode")?.currentValue).toBe("plan")

    await harness.agents.handleMessage(windowId, {
      type: "chat_open",
      session: { ...session, conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    })
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


describe("in-flight config change across chat_delete", () => {
  it("discards a mode change whose answer arrives after chat_delete", async () => {
    process.env.FAKE_AGENT_SLOW_CONFIG_MS = "300"
    try {
      const harness = createHarness()
      await harness.agents.handleMessage(windowId, { type: "chat_open", session })
      const change = harness.agents.handleMessage(windowId, {
        type: "set_config_option",
        configId: "mode",
        value: "agent-full-access",
      })
      await new Promise((resolve) => setTimeout(resolve, 60))

      await harness.agents.handleMessage(windowId, { type: "chat_delete", conversationId })
      const sentAtReset = harness.events.length
      await change
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Neither a session_config nor a notice from the stale answer.
      expect(harness.events.slice(sentAtReset)).toEqual([])
    } finally {
      delete process.env.FAKE_AGENT_SLOW_CONFIG_MS
    }
  })

  it("starts the next chat in the default mode, with nothing carried over", async () => {
    process.env.FAKE_AGENT_SLOW_CONFIG_MS = "300"
    const harness = createHarness()
    try {
      await harness.agents.handleMessage(windowId, { type: "chat_open", session })
      const change = harness.agents.handleMessage(windowId, {
        type: "set_config_option",
        configId: "mode",
        value: "agent-full-access",
      })
      await new Promise((resolve) => setTimeout(resolve, 60))
      await harness.agents.handleMessage(windowId, { type: "chat_delete", conversationId })
      await change
      await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      delete process.env.FAKE_AGENT_SLOW_CONFIG_MS
    }

    harness.events.length = 0
    await harness.agents.handleMessage(windowId, { type: "chat_open", session })

    expect(harness.lastMode()?.currentValue).toBe("read-only")
    expect(notices(harness.events)).toEqual([])
    await harness.agents.handleMessage(windowId, { type: "chat_prompt", text: "hi", session })
    expect(harness.lastMode()?.currentValue).toBe("read-only")
  })
})
