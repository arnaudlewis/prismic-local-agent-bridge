import type { AgentProvider } from "./agents/provider.ts"
import { handleChatOpen } from "./conversations/chatOpen.ts"
import {
  defaultDetachedActivityLimitMs,
  defaultDetachedSweepIntervalMs,
  defaultIdleTtlMs,
  defaultMaxConversations,
  defaultMaxLiveAgents,
} from "./conversations/context.ts"
import type { Context } from "./conversations/context.ts"
import { sendLive, sendToWindow } from "./conversations/output.ts"
import { handlePermissionResponse } from "./conversations/permissions.ts"
import { detachWindow, stopProviderAgents, sweepDetachedConversations } from "./conversations/registry.ts"
import { stopConversation } from "./conversations/idle.ts"
import { handleSetConfigOption } from "./conversations/sessionConfig.ts"
import { handleChatDelete, handleThreadsList } from "./conversations/threads.ts"
import { handleChatCancel, handleChatPrompt } from "./conversations/turn.ts"
import { channelAgent } from "./channelKey.ts"
import { createConversationStore } from "./conversationStore.ts"
import { errorMessage } from "./errors.ts"
import type { AgentId, BridgeEvent, ClientMessage } from "./protocol.ts"
import type { WindowChannels } from "./windowChannels.ts"

export interface CreateAgentSessionsArgs {
  channels: WindowChannels
  dataDir: string
  projectDir: string
  // The agents that can be chosen by `session.agent`.
  providers: AgentProvider[]
  // Override the idle TTL and the resource caps; only tests pass them.
  idleTtlMs?: number
  maxLiveAgents?: number
  maxConversations?: number
  detachedActivityLimitMs?: number
  detachedSweepIntervalMs?: number
  // The per-turn editor context read can be turned off and its timeout shortened; only tests pass these.
  readEditorContext?: boolean
  contextReadTimeoutMs?: number
  // Daemon environment variables handed to the agents on top of the allowlist (--pass-env).
  passEnv?: string[]
}

export interface AgentSessions {
  handleMessage(windowId: string, message: ClientMessage): Promise<void>
  // The conversation, its agent and its transcript outlive the window; this only stops events from going to it.
  detachWindow(windowId: string): void
  stopAll(): void
}

// The conversation machinery behind the WebSocket: routes each client message to its handler. The modules in
// src/conversations hold the logic; this only wires them to the window channels and the lifetime timers.
export function createAgentSessions(args: CreateAgentSessionsArgs): AgentSessions {
  const store = createConversationStore({ dataDir: args.dataDir })
  const ctx: Context = {
    channels: args.channels,
    store,
    providers: new Map<AgentId, AgentProvider>(args.providers.map((provider) => [provider.id, provider])),
    config: {
      projectDir: args.projectDir,
      idleTtlMs: args.idleTtlMs ?? defaultIdleTtlMs,
      liveAgentLimit: args.maxLiveAgents ?? defaultMaxLiveAgents,
      conversationLimit: args.maxConversations ?? defaultMaxConversations,
      activityLimitMs: args.detachedActivityLimitMs ?? defaultDetachedActivityLimitMs,
      readContextEachTurn: args.readEditorContext ?? true,
      passEnv: args.passEnv ?? [],
      contextReadTimeoutMs: args.contextReadTimeoutMs,
    },
    conversations: new Map(),
    windowConversations: new Map(),
    windowScopes: new Map(),
    redactors: new Map(),
    activity: { tick: 0 },
  }

  try {
    store.pruneOldFiles(Date.now())
  } catch (error) {
    console.warn(`Could not prune old conversations: ${errorMessage(error)}`)
  }

  const sweepTimer = setInterval(
    () => sweepDetachedConversations(ctx),
    args.detachedSweepIntervalMs ?? defaultDetachedSweepIntervalMs,
  )
  sweepTimer.unref()

  async function handleMessage(windowId: string, message: ClientMessage): Promise<void> {
    // A socket is opened for one agent: it can't drive the conversations of another.
    const messageAgent = "session" in message ? message.session.agent : "agent" in message ? message.agent : undefined
    const socketAgent = channelAgent(windowId)
    if (messageAgent !== undefined && socketAgent !== undefined && messageAgent !== socketAgent) {
      sendToWindow(ctx, windowId, {
        type: "notice",
        tone: "error",
        text: `This connection is for the ${socketAgent} agent, not ${messageAgent}.`,
      })
      return
    }
    switch (message.type) {
      case "chat_open":
        return handleChatOpen(ctx, windowId, message)
      case "chat_prompt":
        return handleChatPrompt(ctx, windowId, message)
      case "set_config_option":
        return handleSetConfigOption(ctx, windowId, message)
      case "chat_cancel":
        return handleChatCancel(ctx, windowId)
      case "threads_list":
        return handleThreadsList(ctx, windowId, message)
      case "chat_delete":
        return handleChatDelete(ctx, windowId, message)
      case "permission_response":
        return handlePermissionResponse(ctx, windowId, message)
    }
  }

  function stopAll(): void {
    clearInterval(sweepTimer)
    for (const conversation of ctx.conversations.values()) stopConversation(ctx, conversation)
    ctx.conversations.clear()
    ctx.windowConversations.clear()
  }

  args.channels.onMessage((windowId, message) => {
    handleMessage(windowId, message).catch((error: unknown) => {
      console.error(`Failed to handle ${message.type}: ${errorMessage(error)}`)
      const conversation = ctx.windowConversations.get(windowId)
      const notice: BridgeEvent = { type: "notice", tone: "error", text: `Agent error: ${errorMessage(error)}` }
      if (conversation === undefined) sendToWindow(ctx, windowId, notice)
      else sendLive(ctx, conversation, notice)
      sendToWindow(ctx, windowId, { type: "chat_status", status: "idle" })
    })
  })
  args.channels.onWindowClosed((windowId) => detachWindow(ctx, windowId))
  for (const provider of args.providers) {
    provider.onCredentialsRemoved?.((notice) => stopProviderAgents(ctx, provider.id, notice))
  }

  return { handleMessage, detachWindow: (windowId) => detachWindow(ctx, windowId), stopAll }
}

