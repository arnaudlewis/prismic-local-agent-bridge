import { AgentIdSchema } from "./protocol.ts"
import type { AgentId } from "./protocol.ts"

// One WebSocket per (browser window, agent): the Codex and Claude panels of one window don't evict each other. The
// conversation machinery treats this key as the opaque identity of "the window it talks to"; only the MCP header
// X-Prismic-Window-Id (which must be the browser's own window id) and the check below look inside it.
export function channelKey(windowId: string, agent: AgentId): string {
  return `${windowId}/${agent}`
}

// The browser's window id: what the Prismic MCP server knows the window by.
export function browserWindowId(key: string): string {
  return key.split("/")[0] ?? key
}

// The agent a channel was opened for, if the key has one.
export function channelAgent(key: string): AgentId | undefined {
  const agent = AgentIdSchema.safeParse(key.split("/")[1])
  return agent.success ? agent.data : undefined
}
