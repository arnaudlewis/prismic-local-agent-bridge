import type { SessionNotification } from "@agentclientprotocol/sdk"

import type { Context } from "./context.ts"
import { providerOf } from "./context.ts"
import { offeredCommands } from "./commands.ts"
import { emit } from "./output.ts"
import { sendAvailableCommands, sendSessionConfig } from "./sessionConfig.ts"
import { handleToolOutput } from "./turnContext.ts"
import type { AgentFields, Conversation } from "./types.ts"

// What the agent reports while it works, turned into the events the browser renders.
export function handleSessionUpdate(
  ctx: Context,
  conversation: Conversation,
  agent: AgentFields,
  notification: SessionNotification,
): void {
  if (agent.sessionId !== "" && notification.sessionId !== agent.sessionId) return
  const update = notification.update
  if (update.sessionUpdate === "available_commands_update") {
    // Kept even while replaying: it is session state, not history, and is re-sent once the agent is ready.
    agent.availableCommands = offeredCommands(providerOf(ctx, conversation), update.availableCommands)
    if (!agent.replaying) sendAvailableCommands(ctx, conversation, agent)
    return
  }
  if (agent.replaying) return
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type !== "text") return
      emit(ctx, conversation, {
        type: "agent_message_chunk",
        text: update.content.text,
        messageId: update.messageId ?? undefined,
      })
      return
    case "tool_call":
      emit(ctx, conversation, {
        type: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
      })
      handleToolOutput(ctx, conversation, agent, update)
      return
    case "tool_call_update":
      emit(ctx, conversation, {
        type: "tool_call_update",
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
      })
      handleToolOutput(ctx, conversation, agent, update)
      return
    case "config_option_update":
      agent.configOptions = update.configOptions
      sendSessionConfig(ctx, conversation, agent)
      return
    default:
      return
  }
}
