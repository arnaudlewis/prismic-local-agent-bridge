import type { Context } from "./context.ts"
import { flushSave } from "./output.ts"
import { stopAgent } from "./stop.ts"
import type { Conversation } from "./types.ts"

// A conversation nobody looks at (no window, no turn running) is stopped after the idle TTL.
export function refreshIdleTimer(ctx: Context, conversation: Conversation): void {
  clearTimeout(conversation.idleTimer)
  conversation.idleTimer = undefined
  if (conversation.windowId !== undefined || conversation.process?.turnActive === true) return
  conversation.idleTimer = setTimeout(() => evict(ctx, conversation), ctx.config.idleTtlMs)
  conversation.idleTimer.unref()
}

// Stops the agent and drops the conversation from memory; the transcript stays on disk and reloads on the next open.
export function evict(ctx: Context, conversation: Conversation): void {
  stopConversation(ctx, conversation)
  ctx.conversations.delete(conversation.id)
}

export function stopConversation(ctx: Context, conversation: Conversation): void {
  clearTimeout(conversation.idleTimer)
  conversation.idleTimer = undefined
  stopAgent(ctx, conversation)
  flushSave(ctx, conversation)
}
