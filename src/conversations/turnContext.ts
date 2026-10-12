import { randomUUID } from "node:crypto"

import type { ToolUpdate } from "../agents/provider.ts"
import {
  buildEditorContextBlock,
  editorContextKey,
  isEditorContextTool,
  summarizeEditorContext,
} from "../editorContext.ts"
import { browserWindowId } from "../channelKey.ts"
import { readEditorContext } from "../editorContextClient.ts"
import type { Context } from "./context.ts"
import { providerOf } from "./context.ts"
import { emit, notify } from "./output.ts"
import type { AgentFields, Conversation } from "./types.ts"

const maxTrackedToolCalls = 512
// A failed read is mentioned at most this often per conversation.
const contextNoticeIntervalMs = 10 * 60 * 1000
const contextReadFailedNotice = "Couldn't read the editor context this turn."

interface ReadTurnContextArgs {
  conversation: Conversation
  agent: AgentFields
  generation: number
}

// Reads the editor context itself instead of leaving it to the model. A failure only costs this turn its context
// block (the preamble still tells the agent to call the tool): it never blocks or fails the turn.
export async function readTurnContext(ctx: Context, args: ReadTurnContextArgs): Promise<string | undefined> {
  const { conversation, agent, generation } = args
  const windowId = conversation.windowId
  if (windowId === undefined) return undefined
  const outcome = await readEditorContext({
    upstream: ctx.prismic.upstream,
    mcpOrigin: agent.startedWith.mcpOrigin,
    windowId: browserWindowId(windowId),
    pinnedDocumentId: conversation.pinnedDocumentId,
    timeoutMs: ctx.config.contextReadTimeoutMs,
  })
  if (conversation.generation !== generation || conversation.process !== agent) return undefined

  const block = outcome.ok ? buildEditorContextBlock(outcome.value, conversation.pinnedDocumentId) : undefined
  if (!outcome.ok || block === undefined) {
    console.warn(`Editor context read failed: ${outcome.ok ? "invalid response" : outcome.reason}`)
    noteContextReadFailure(ctx, conversation)
    return undefined
  }
  emitEditorContext(ctx, conversation, `bridge-${randomUUID()}`, outcome.value)
  return block
}

function noteContextReadFailure(ctx: Context, conversation: Conversation): void {
  const now = Date.now()
  if (conversation.lastContextNoticeAt !== undefined && now - conversation.lastContextNoticeAt < contextNoticeIntervalMs) {
    return
  }
  conversation.lastContextNoticeAt = now
  notify(ctx, conversation, "info", contextReadFailedNotice)
}

// The same path for the bridge's own read and for the agent's get_editor_context calls: parsed and deduped once.
function emitEditorContext(ctx: Context, conversation: Conversation, toolCallId: string, result: unknown): void {
  const summary = summarizeEditorContext(result)
  if (summary === undefined) return
  const key = editorContextKey(summary)
  if (key === conversation.lastEditorContext) return
  conversation.lastEditorContext = key
  emit(ctx, conversation, { type: "editor_context", toolCallId, context: summary })
}

// Catches the result of the agent's own get_editor_context calls, as its provider reports tool calls.
export function handleToolOutput(ctx: Context, conversation: Conversation, agent: AgentFields, update: ToolUpdate): void {
  const provider = providerOf(ctx, conversation)
  const identity = provider.identifyToolCall(update) ?? agent.toolIdentities.get(update.toolCallId)
  if (identity !== undefined) {
    agent.toolIdentities.set(update.toolCallId, identity)
    if (agent.toolIdentities.size > maxTrackedToolCalls) {
      const oldest = agent.toolIdentities.keys().next().value
      if (oldest !== undefined) agent.toolIdentities.delete(oldest)
    }
  }
  const finished = update.status === "completed" || update.status === "failed"
  if (!finished) return
  agent.toolIdentities.delete(update.toolCallId)
  if (update.status !== "completed" || !isEditorContextTool(identity)) return

  emitEditorContext(ctx, conversation, update.toolCallId, provider.readToolResult(update))
}
