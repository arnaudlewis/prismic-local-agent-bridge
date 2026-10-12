import { errorMessage } from "../errors.ts"
import type { ClientMessage } from "../protocol.ts"
import type { Context } from "./context.ts"
import { sendToWindow } from "./output.ts"
import { stopAgent } from "./stop.ts"
import type { Conversation } from "./types.ts"

// A window only sees the threads of the repository of its last accepted session (chat_open / chat_prompt): what it
// asks for beyond that, or before it has a session at all, is an empty list, so titles of other repositories are
// never enumerated.
export function handleThreadsList(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "threads_list" }>,
): void {
  const scope = ctx.windowScopes.get(windowId)
  const threads =
    scope?.repository === message.repository ? ctx.store.listThreads(message.repository, message.agent) : []
  sendToWindow(ctx, windowId, { type: "threads", threads })
}

// Only conversations the daemon knows (running, or in the index) can be deleted: an unknown id changes nothing.
// The answer is the window's own list, whatever the deleted conversation was.
export function handleChatDelete(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "chat_delete" }>,
): void {
  const id = message.conversationId
  const conversation = ctx.conversations.get(id)
  if (conversation !== undefined || ctx.store.threadOf(id) !== undefined) deleteConversation(ctx, id, conversation)
  const scope = ctx.windowScopes.get(windowId)
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
