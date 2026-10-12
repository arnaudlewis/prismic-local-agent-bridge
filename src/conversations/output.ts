import { errorMessage } from "../errors.ts"
import type { BridgeEvent, HistoryEvent, RecordedBridgeEvent } from "../protocol.ts"
import { knownSecrets } from "./context.ts"
import type { Context } from "./context.ts"
import { createMessageRedactor, redactEvent, redactText } from "./redaction.ts"
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

function redactorOf(ctx: Context, conversation: Conversation) {
  let redactor = ctx.redactors.get(conversation.id)
  if (redactor === undefined) {
    redactor = createMessageRedactor()
    ctx.redactors.set(conversation.id, redactor)
  }
  return redactor
}

// Everything the UI renders goes through here so a window that attaches later can replay it. It is also the one place
// where secrets are taken out of what the daemon sends and stores: an agent can repeat its own API key (a prompt
// injection can ask it to), and a key can arrive split across the chunks of one message.
export function emit(ctx: Context, conversation: Conversation, event: RecordedBridgeEvent): void {
  touch(ctx, conversation)
  const secrets = knownSecrets(ctx)
  const redactor = redactorOf(ctx, conversation)
  if (event.type === "agent_message_chunk") {
    for (const piece of redactor.push(event.messageId, event.text, secrets)) deliver(ctx, conversation, chunkOf(piece))
    return
  }
  // Whatever an unfinished message was holding back comes out before the next event.
  for (const piece of redactor.flush(secrets)) deliver(ctx, conversation, chunkOf(piece))
  deliver(ctx, conversation, redactEvent(event, secrets))
}

function chunkOf(piece: { messageId: string | undefined; text: string }): RecordedBridgeEvent {
  return { type: "agent_message_chunk", text: piece.text, ...(piece.messageId === undefined ? {} : { messageId: piece.messageId }) }
}

function deliver(ctx: Context, conversation: Conversation, event: RecordedBridgeEvent): void {
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
  conversation.transcript.append(redactEvent(event, knownSecrets(ctx)))
  scheduleSave(ctx, conversation)
}

// The user's own words, a title made from them, and anything else a person could paste a key into.
export function redact(ctx: Context, text: string): string {
  return redactText(text, knownSecrets(ctx))
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
      repository: redact(ctx, conversation.repository),
      acpSessionId: conversation.resumeSessionId,
      pinnedDocumentId: conversation.pinnedDocumentId,
      title: conversation.title === undefined ? undefined : redact(ctx, conversation.title),
      updatedAt: conversation.updatedAt,
      events,
    })
  } catch (error) {
    console.warn(`Could not save conversation ${conversation.id}: ${errorMessage(error)}`)
  }
}
