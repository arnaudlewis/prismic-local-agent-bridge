import type { ToolIdentity } from "../../editorContext.ts"
import { extractToolResultJson } from "../../editorContext.ts"
import type { ToolUpdate } from "../provider.ts"

// Claude Code names an MCP tool `mcp__<server>__<tool>`. claude-agent-acp reports that name as the tool call's
// `name` and `title`, and again as `_meta.claudeCode.toolName` on its updates.
function fromToolName(name: unknown): ToolIdentity | undefined {
  if (typeof name !== "string") return undefined
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match?.[1] === undefined || match[2] === undefined ? undefined : { server: match[1], tool: match[2] }
}

export function identifyToolCall(update: ToolUpdate): ToolIdentity | undefined {
  const meta = update._meta as { claudeCode?: { toolName?: unknown } } | undefined | null
  return fromToolName(update.name) ?? fromToolName(meta?.claudeCode?.toolName) ?? fromToolName(update.title)
}

// A finished call carries the tool result as content blocks (or, when nothing else carries it, as rawOutput).
export function readToolResult(update: ToolUpdate): unknown {
  return extractToolResultJson(update)
}
