import { errorMessage } from "../errors.ts"
import type { ClientMessage } from "../protocol.ts"
import type { Context } from "./context.ts"
import { sendToWindow } from "./output.ts"
import { stopAgent } from "./stop.ts"
import type { Conversation } from "./types.ts"

export function handleThreadsList(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "threads_list" }>,
): void {
  ctx.windowScopes.set(windowId, { repository: message.repository, agent: message.agent })
  sendToWindow(ctx, windowId, {
    type: "threads",
    threads: ctx.store.listThreads(message.repository, message.agent),
  })
}

// Only conversations the daemon knows (running, or in the index) can be deleted: an unknown id changes nothing.
export function handleChatDelete(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "chat_delete" }>,
): void {
  const id = message.conversationId
  const conversation = ctx.conversations.get(id)
  const indexed = ctx.store.threadOf(id)
  const known = conversation ?? indexed
  if (known !== undefined) deleteConversation(ctx, id, conversation)
  // The list the window was looking at: the deleted conversation's, or, for an unknown id, the window's own.
  const scope = known ?? ctx.windowScopes.get(windowId)
  const threads = scope === undefined ? [] : ctx.store.listThreads(scope.repository, scope.agent)
  sendToWindow(ctx, windowId, { type: "threads", threads })
}

function deleteConversation(ctx: Context, id: string, conversation: Conversation | undefined): void {
  if (conversation !== undefined) {
    // First, so that stopping the agent (which cancels its pending permissions) can't write the file again.
    conversation.deleted = true
    stopAgent(ctx, conversation)
    clearTimeout(conversation.idleTimer)
    clearTimeout(conversation.saveTimer)
    conversation.idleTimer = undefined
    conversation.saveTimer = undefined
    if (conversation.windowId !== undefined) {
      ctx.windowConversations.delete(conversation.windowId)
      conversation.windowId = undefined
    }
    ctx.conversations.delete(id)
  }
  try {
    ctx.store.remove(id)
  } catch (error) {
    console.warn(`Could not delete conversation ${id}: ${errorMessage(error)}`)
  }
}
