import { describe, expect, it } from "vitest"

import { browserWindowId, channelAgent, channelKey } from "./channelKey.ts"

const windowId = "11111111-1111-4111-8111-111111111111"

describe("channel keys", () => {
  it("combine the browser window id and the agent, and take them apart again", () => {
    const key = channelKey(windowId, "claude")

    expect(key).toBe(`${windowId}/claude`)
    expect(browserWindowId(key)).toBe(windowId)
    expect(channelAgent(key)).toBe("claude")
  })

  it("differ per agent for one window", () => {
    expect(channelKey(windowId, "codex")).not.toBe(channelKey(windowId, "claude"))
  })

  it("leave a plain window id alone", () => {
    expect(browserWindowId(windowId)).toBe(windowId)
    expect(channelAgent(windowId)).toBeUndefined()
    expect(channelAgent(`${windowId}/unknown`)).toBeUndefined()
  })
})
