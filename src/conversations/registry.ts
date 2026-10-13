import { errorMessage } from "../errors.ts"
import { editorContextKey } from "../editorContext.ts"
import type { AgentId, HistoryEvent, Session } from "../protocol.ts"
import { deriveTitle } from "../threadTitle.ts"
import { createTranscript } from "../transcript.ts"
import type { Context } from "./context.ts"
import { evict, refreshIdleTimer } from "./idle.ts"
import { flushSave, notify, scheduleSave, setStatus, touch } from "./output.ts"
import { cancelPendingPermissions, stopAgent } from "./stop.ts"
import type { Conversation } from "./types.ts"

const cancelGraceMs = 60_000

// The conversation map: loading, window attachment, and the caps that keep resident agents bounded.
export function getConversation(ctx: Context, session: Session): Conversation {
  const existing = ctx.conversations.get(session.conversationId)
  if (existing !== undefined) {
    assertSameAgent(existing.agent, session)
    existing.repository = session.repository
    existing.showReasoning = session.showReasoning === true
    return existing
  }
  makeRoomInMemory(ctx)
  const stored = ctx.store.load(session.conversationId)
  if (stored !== undefined) assertSameAgent(stored.agent, session)
  const transcript = createTranscript({ events: stored?.events })
  // The agent that was waiting on these is gone, so they can't be answered anymore.
  for (const requestId of transcript.unresolvedPermissionIds()) {
    transcript.append({ type: "permission_resolved", requestId })
  }
  const conversation: Conversation = {
    id: session.conversationId,
    agent: session.agent,
    repository: session.repository,
    windowId: undefined,
    process: undefined,
    selectedConfig: {},
    ensuring: undefined,
    starting: false,
    startingChild: undefined,
    startingGrant: undefined,
    lastActiveAt: 0,
    generation: 0,
    resumeSessionId: stored?.acpSessionId,
    preambleVersion: stored?.preambleVersion,
    pinnedDocumentId: undefined,
    title: stored === undefined ? undefined : storedTitle(stored.title, stored.events),
    updatedAt: stored?.updatedAt ?? Date.now(),
    deleted: false,
    busySince: undefined,
    showReasoning: session.showReasoning === true,
    thoughtBytes: 0,
    lastContextNoticeAt: undefined,
    transcript,
    lastEditorContext: lastEditorContextKey(transcript.events()),
    saveTimer: undefined,
    idleTimer: undefined,
  }
  touch(ctx, conversation)
  ctx.conversations.set(conversation.id, conversation)
  return conversation
}

// A conversation id belongs to one agent for good: its stored session can't be resumed by another one.
function assertSameAgent(agent: string, session: Session): void {
  if (agent !== session.agent) throw new Error("This conversation belongs to another agent")
}

export function attachWindow(ctx: Context, conversation: Conversation, windowId: string): void {
  const previous = ctx.windowConversations.get(windowId)
  if (previous !== undefined && previous !== conversation) {
    if (previous.windowId === windowId) previous.windowId = undefined
    refreshIdleTimer(ctx, previous)
  }
  if (conversation.windowId !== undefined && conversation.windowId !== windowId) {
    ctx.windowConversations.delete(conversation.windowId)
  }
  conversation.windowId = windowId
  ctx.windowConversations.set(windowId, conversation)
  ctx.windowScopes.set(windowId, { repository: conversation.repository, agent: conversation.agent })
  touch(ctx, conversation)
  refreshIdleTimer(ctx, conversation)
}

export function detachWindow(ctx: Context, windowId: string): void {
  const conversation = ctx.windowConversations.get(windowId)
  if (conversation === undefined) return
  ctx.windowConversations.delete(windowId)
  ctx.windowScopes.delete(windowId)
  if (conversation.windowId === windowId) conversation.windowId = undefined
  refreshIdleTimer(ctx, conversation)
}

// Detached conversations without an agent only cost memory: drop them (they stay on disk) to bound the map.
function makeRoomInMemory(ctx: Context): void {
  while (ctx.conversations.size >= ctx.config.conversationLimit) {
    const victim = leastRecentlyActive(
      [...ctx.conversations.values()].filter(
        (candidate) =>
          candidate.windowId === undefined &&
          candidate.process === undefined &&
          !candidate.starting &&
          candidate.ensuring === undefined,
      ),
    )
    if (victim === undefined) return
    evict(ctx, victim)
  }
}

// Stops the least recently active agent nobody is looking at, if it is idle, until there is room for one more.
export function makeRoomForAgent(ctx: Context, requester: Conversation): boolean {
  while (countLiveAgents(ctx, requester) >= ctx.config.liveAgentLimit) {
    const victim = leastRecentlyActive(
      [...ctx.conversations.values()].filter(
        (candidate) =>
          candidate !== requester &&
          candidate.process !== undefined &&
          candidate.windowId === undefined &&
          !candidate.process.turnActive &&
          candidate.process.pendingPermissions.size === 0,
      ),
    )
    if (victim === undefined) return false
    stopAgent(ctx, victim)
    flushSave(ctx, victim)
    refreshIdleTimer(ctx, victim)
  }
  return true
}

function countLiveAgents(ctx: Context, except: Conversation): number {
  let count = 0
  for (const candidate of ctx.conversations.values()) {
    if (candidate !== except && (candidate.process !== undefined || candidate.starting)) count += 1
  }
  return count
}

// Cancels what a detached conversation has been doing for too long (a turn, or an approval nobody answers).
export function sweepDetachedConversations(ctx: Context): void {
  const now = Date.now()
  for (const conversation of ctx.conversations.values()) {
    const agent = conversation.process
    if (agent === undefined || conversation.windowId !== undefined) continue
    const turnTooLong = agent.turnActive && now - agent.turnStartedAt > ctx.config.activityLimitMs
    const permissionTooOld = [...agent.pendingPermissions.values()].some(
      (pending) => now - pending.createdAt > ctx.config.activityLimitMs,
    )
    if (!turnTooLong && !permissionTooOld) continue
    if (agent.cancelRequestedAt === undefined) {
      agent.cancelRequestedAt = now
      cancelPendingPermissions(ctx, conversation, agent)
      agent.connection.cancel({ sessionId: agent.sessionId }).catch((error: unknown) => {
        console.warn(`Could not cancel a detached turn: ${errorMessage(error)}`)
      })
    } else if (now - agent.cancelRequestedAt > cancelGraceMs) {
      notify(ctx, conversation, "error", "The local agent was stopped because it didn't finish after being cancelled.")
      stopAgent(ctx, conversation)
      scheduleSave(ctx, conversation)
      refreshIdleTimer(ctx, conversation)
    }
  }
}

// The agent's credentials are gone: every conversation running on it is stopped at once (a turn is cancelled, its
// approvals denied), told why, and its window sees it idle. The next prompt asks for the credentials again.
export function stopProviderAgents(ctx: Context, agent: AgentId, notice: string): void {
  for (const conversation of ctx.conversations.values()) {
    if (conversation.agent !== agent) continue
    // Also a conversation that is only getting ready (waiting for its old agent to exit, authenticating, handshaking):
    // stopping it bumps its generation, which aborts that start.
    const busy = conversation.process !== undefined || conversation.starting || conversation.ensuring !== undefined
    if (!busy) continue
    stopAgent(ctx, conversation)
    notify(ctx, conversation, "error", notice)
    setStatus(ctx, conversation, "idle")
    scheduleSave(ctx, conversation)
    refreshIdleTimer(ctx, conversation)
  }
}

function leastRecentlyActive(candidates: Conversation[]): Conversation | undefined {
  let oldest: Conversation | undefined
  for (const candidate of candidates) {
    if (oldest === undefined || candidate.lastActiveAt < oldest.lastActiveAt) oldest = candidate
  }
  return oldest
}

// Conversations saved before titles existed get theirs from their first user message.
function storedTitle(title: string | undefined, events: HistoryEvent[]): string | undefined {
  if (title !== undefined) return title
  const first = events.find((event) => event.type === "user_message")
  return first?.type === "user_message" ? deriveTitle(first.text) : undefined
}

function lastEditorContextKey(events: HistoryEvent[]): string | undefined {
  const last = events.findLast((event) => event.type === "editor_context")
  return last?.type === "editor_context" ? editorContextKey(last.context) : undefined
}
