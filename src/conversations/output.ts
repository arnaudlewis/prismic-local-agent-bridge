import { errorMessage } from "../errors.ts"
import type { BridgeEvent, HistoryEvent, RecordedBridgeEvent } from "../protocol.ts"
import { knownSecrets } from "./context.ts"
import type { Context } from "./context.ts"
import { createMessageRedactor, redactEvent, redactText } from "./redaction.ts"
import type { Conversation } from "./types.ts"

const saveDebounceMs = 500

// Every event to a browser window ends here, and is redacted once more: stored history, thread titles and anything
// else that didn't go through emit() can hold a key the daemon only learned about later.
export function sendToWindow(ctx: Context, windowId: string, event: BridgeEvent): void {
  ctx.channels.send(windowId, redactEvent(event, knownSecrets(ctx)))
}

export function sendLive(ctx: Context, conversation: Conversation, event: BridgeEvent): void {
  if (conversation.windowId !== undefined) sendToWindow(ctx, conversation.windowId, event)
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
  // Only the end of the turn is a boundary for held text: a tool call or a permission request in the middle of a
  // message is not, and must not make a half-arrived key look finished.
  if (event.type === "turn_end") flushHeldText(ctx, conversation)
  deliver(ctx, conversation, redactEvent(event, secrets))
}

// A genuine boundary (the turn ended, failed or was cancelled; the agent stopped): what the redactor still holds goes
// out now, redacted if it starts like a key and as it is otherwise.
export function flushHeldText(ctx: Context, conversation: Conversation): void {
  const redactor = ctx.redactors.get(conversation.id)
  if (redactor !== undefined) {
    for (const piece of redactor.flushAll(knownSecrets(ctx))) deliver(ctx, conversation, chunkOf(piece))
  }
  const thoughts = ctx.redactors.get(thoughtKey(conversation))
  if (thoughts !== undefined) deliverThoughts(ctx, conversation, thoughts.flushAll(knownSecrets(ctx)))
}

function thoughtChunkOf(piece: { messageId: string | undefined; text: string }): BridgeEvent {
  return { type: "agent_thought_chunk", text: piece.text, ...(piece.messageId === undefined ? {} : { messageId: piece.messageId }) }
}

// What a turn may send of the agent's reasoning: a model that thinks without end, or a faulty agent, must not keep the
// daemon serializing and a slow browser queueing forever. Past it the rest of the turn's reasoning is dropped (the
// sanitizer still sees it, so the stream stays consistent); the messages are not affected.
export const maxThoughtBytesPerTurn = 512 * 1024

// The agent's reasoning. It is live only: never recorded, never replayed, so it is not in the transcript on disk. Every
// chunk goes through its own redactor (apart from the one of the messages, whose held tails are keyed by message id)
// whether or not the browser asked to see it: the sanitizer must have seen the beginning of a key to recognize its end,
// so the setting (which the page can change in the middle of a turn) only decides what is delivered, never what is
// sanitized.
export function emitThought(ctx: Context, conversation: Conversation, event: { text: string; messageId?: string }): void {
  touch(ctx, conversation)
  const key = thoughtKey(conversation)
  let redactor = ctx.redactors.get(key)
  if (redactor === undefined) {
    redactor = createMessageRedactor()
    ctx.redactors.set(key, redactor)
  }
  deliverThoughts(ctx, conversation, redactor.push(event.messageId, event.text, knownSecrets(ctx)))
}

// The one place thoughts leave the daemon: the setting of the session that is attached now, and the budget of the turn.
function deliverThoughts(ctx: Context, conversation: Conversation, pieces: Array<{ messageId: string | undefined; text: string }>): void {
  if (!conversation.showReasoning) return
  for (const piece of pieces) {
    if (conversation.thoughtBytes >= maxThoughtBytesPerTurn) return
    conversation.thoughtBytes += Buffer.byteLength(piece.text)
    sendLive(ctx, conversation, thoughtChunkOf(piece))
  }
}

export function thoughtKey(conversation: Conversation): string {
  return `${conversation.id}#thought`
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
  if (status === "idle") {
    conversation.busySince = undefined
    conversation.thoughtBytes = 0
    sendLive(ctx, conversation, { type: "chat_status", status })
    return
  }
  // Starting, then running, is one busy period: the clock keeps its start.
  conversation.busySince ??= Date.now()
  sendLive(ctx, conversation, { type: "chat_status", status, elapsedMs: Date.now() - conversation.busySince })
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
