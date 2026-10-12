import type { ClientMessage } from "../protocol.ts"
import { ensureAgent } from "./agentProcess.ts"
import { providerOf } from "./context.ts"
import type { Context } from "./context.ts"
import { currentStatus, sendToWindow, setStatus } from "./output.ts"
import { attachWindow, getConversation } from "./registry.ts"
import { sendAgentState, withoutProtectedConfig } from "./sessionConfig.ts"

// Opens (or switches to) a conversation in a window: its history first, then the agent's state once it is ready.
export async function handleChatOpen(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "chat_open" }>,
): Promise<void> {
  const conversation = getConversation(ctx, message.session)
  attachWindow(ctx, conversation, windowId)
  if (Object.keys(conversation.selectedConfig).length === 0 && message.preferredConfig !== undefined) {
    conversation.selectedConfig = withoutProtectedConfig(
      message.preferredConfig,
      providerOf(ctx, conversation).protectedConfigIds,
    )
  }
  sendToWindow(ctx, windowId, { type: "chat_history", events: conversation.transcript.events() })
  setStatus(ctx, conversation, conversation.process?.turnActive === true ? "running" : "starting")
  const before = conversation.process
  const ready = await ensureAgent(ctx, conversation, windowId, message.session)
  if (ready && conversation.process !== undefined && conversation.process === before) {
    sendAgentState(ctx, conversation, conversation.process)
  }
  setStatus(ctx, conversation, currentStatus(conversation))
}
