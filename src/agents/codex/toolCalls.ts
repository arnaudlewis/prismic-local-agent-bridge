import type { ToolIdentity } from "../../editorContext.ts"
import { extractToolResultJson } from "../../editorContext.ts"
import type { ToolUpdate } from "../provider.ts"

// codex-acp titles MCP calls `mcp.<server>.<tool>` and puts { server, tool, arguments } in rawInput. Updates repeat
// neither when they are unchanged, so callers remember the identity from the start report.
export function identifyToolCall(update: ToolUpdate): ToolIdentity | undefined {
  const input = update.rawInput
  if (typeof input === "object" && input !== null) {
    const { server, tool } = input as { server?: unknown; tool?: unknown }
    if (typeof server === "string" && typeof tool === "string") return { server, tool }
  }
  const match = typeof update.title === "string" ? /^mcp\.([^.]+)\.(.+)$/.exec(update.title) : null
  if (match?.[1] !== undefined && match[2] !== undefined) return { server: match[1], tool: match[2] }
  return undefined
}

// codex-acp reports a finished MCP call as rawOutput { result, error } (result is the MCP tool result).
export function readToolResult(update: ToolUpdate): unknown {
  return extractToolResultJson(update)
}
