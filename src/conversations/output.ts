import { errorMessage } from "../errors.ts"
import type { BridgeEvent, HistoryEvent, RecordedBridgeEvent } from "../protocol.ts"
import type { Context } from "./context.ts"
import type { Conversation } from "./types.ts"

const saveDebounceMs = 500

export function sendToWindow(ctx: Context, windowId: string, event: BridgeEvent): void {
  ctx.channels.send(windowId, event)
}

export function sendLive(ctx: Context, conversation: Conversation, event: BridgeEvent): void {
  if (conversation.windowId !== undefined) ctx.channels.send(conversation.windowId, event)
}

export function touch(ctx: Context, conversation: Conversation): void {
  ctx.activity.tick += 1
  conversation.lastActiveAt = ctx.activity.tick
}

// Everything the UI renders goes through here so a window that attaches later can replay it.
export function emit(ctx: Context, conversation: Conversation, event: RecordedBridgeEvent): void {
  touch(ctx, conversation)
  record(ctx, conversation, event)
  sendLive(ctx, conversation, event)
  if (event.type === "turn_end") {
    // The thread list shows when a conversation was last active: save now so the index has it.
    conversation.updatedAt = Date.now()
    flushSave(ctx, conversation)
    pushThreads(ctx, conversation)
  }
}

export function record(ctx: Context, conversation: Conversation, event: HistoryEvent): void {
  conversation.transcript.append(event)
  scheduleSave(ctx, conversation)
}

export function notify(ctx: Context, conversation: Conversation, tone: "info" | "error", text: string): void {
  emit(ctx, conversation, { type: "notice", tone, text })
}

export function setStatus(ctx: Context, conversation: Conversation, status: "idle" | "starting" | "running"): void {
  sendLive(ctx, conversation, { type: "chat_status", status })
}

export function currentStatus(conversation: Conversation): "idle" | "running" {
  return conversation.process?.turnActive === true ? "running" : "idle"
}

export function pushThreads(ctx: Context, conversation: Conversation): void {
  if (conversation.windowId === undefined) return
  try {
    const threads = ctx.store.listThreads(conversation.repository, conversation.agent)
    sendLive(ctx, conversation, { type: "threads", threads })
  } catch (error) {
    console.warn(`Could not list threads: ${errorMessage(error)}`)
  }
}

export function scheduleSave(ctx: Context, conversation: Conversation): void {
  if (conversation.deleted || conversation.saveTimer !== undefined) return
  conversation.saveTimer = setTimeout(() => flushSave(ctx, conversation), saveDebounceMs)
  conversation.saveTimer.unref()
}

export function flushSave(ctx: Context, conversation: Conversation): void {
  clearTimeout(conversation.saveTimer)
  conversation.saveTimer = undefined
  if (conversation.deleted) return
  const events = conversation.transcript.events()
  if (events.length === 0 && conversation.resumeSessionId === undefined) return
  try {
    ctx.store.save({
      version: 1,
      conversationId: conversation.id,
      agent: conversation.agent,
      repository: conversation.repository,
      acpSessionId: conversation.resumeSessionId,
      pinnedDocumentId: conversation.pinnedDocumentId,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      events,
    })
  } catch (error) {
    console.warn(`Could not save conversation ${conversation.id}: ${errorMessage(error)}`)
  }
}
