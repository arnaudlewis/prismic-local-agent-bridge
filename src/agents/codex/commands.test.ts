import { describe, expect, it } from "vitest"

import { nativeCommandName, parseSlashCommand } from "./commands.ts"

describe("native commands of the Codex provider", () => {
  it.each([
    "/status",
    "  /review check the diff",
    "/review-branch main",
    "/compact\n",
    "/ status",
    "/\u00a0status",
    "\u00a0/status",
    "// ",
    "/etc/hosts",
  ])("detects %j like codex-acp does", (text) => {
    expect(nativeCommandName(text) !== undefined).toBe(true)
  })

  it.each(["status", "what does /status do", "/$skill", "/ $skill", "/", "/  ", "/\n", " ", ""])(
    "ignores %j",
    (text) => {
      expect(nativeCommandName(text) !== undefined).toBe(false)
    },
  )

  it.each([
    ["/logout", "logout"],
    ["/ logout", "logout"],
    ["/\tGOAL now", "goal"],
    ["/\u00a0review", "review"],
    ["\ufeff/Logout", "logout"],
    ["/\u2028goal", "goal"],
    ["//logout", "/logout"],
    ["/a b c", "a"],
  ])("parses %j as command %j", (text, name) => {
    expect(parseSlashCommand(text)).toBe(name)
  })
})
