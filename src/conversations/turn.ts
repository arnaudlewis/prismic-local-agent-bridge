import { errorMessage } from "../errors.ts"
import type { ClientMessage } from "../protocol.ts"
import { deriveTitle } from "../threadTitle.ts"
import { ensureAgent } from "./agentProcess.ts"
import { blockedCommandName, blockedCommandNotice, isNativeCommand } from "./commands.ts"
import { providerOf } from "./context.ts"
import type { Context } from "./context.ts"
import { buildPreamble } from "./preamble.ts"
import { attachWindow, getConversation } from "./registry.ts"
import { refreshIdleTimer } from "./idle.ts"
import { emit, flushHeldText, flushSave, notify, pushThreads, record, redact, scheduleSave, setStatus } from "./output.ts"
import { cancelPendingPermissions } from "./stop.ts"
import { readTurnContext } from "./turnContext.ts"

// One user message: checks, the user's text recorded, then the prompt to the agent with its extra content blocks.
export async function handleChatPrompt(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "chat_prompt" }>,
): Promise<void> {
  const conversation = getConversation(ctx, message.session)
  attachWindow(ctx, conversation, windowId)
  const provider = providerOf(ctx, conversation)
  if (conversation.process?.turnActive === true) {
    notify(ctx, conversation, "info", "A reply is already in progress.")
    return
  }
  const blocked = blockedCommandName(provider, message.text)
  if (blocked !== undefined) {
    notify(ctx, conversation, "error", blockedCommandNotice(blocked))
    setStatus(ctx, conversation, "idle")
    return
  }
  setStatus(ctx, conversation, "starting")
  const ready = await ensureAgent(ctx, conversation, windowId)
  if (!ready) return
  const agent = conversation.process
  if (agent === undefined) {
    setStatus(ctx, conversation, "idle")
    return
  }
  if (agent.turnActive) {
    notify(ctx, conversation, "info", "A reply is already in progress.")
    return
  }

  // Native slash commands run inside the agent and never reach the model: no context, no preamble.
  const isRegularPrompt = !isNativeCommand(provider, message.text)

  record(ctx, conversation, { type: "user_message", text: message.text })
  conversation.resumeSessionId = agent.sessionId
  if (conversation.pinnedDocumentId === undefined && message.session.document !== undefined) {
    conversation.pinnedDocumentId = message.session.document.id
    scheduleSave(ctx, conversation)
  }
  conversation.updatedAt = Date.now()
  if (conversation.title === undefined) {
    // The thread appears in the list as soon as it has a first message.
    conversation.title = deriveTitle(redact(ctx, message.text))
    flushSave(ctx, conversation)
    pushThreads(ctx, conversation)
  }
  // Set before anything is awaited, so a second prompt can't start while the context is being read.
  const generation = conversation.generation
  agent.turnActive = true
  agent.turnStartedAt = Date.now()
  agent.cancelRequestedAt = undefined
  agent.cancelRequested = false
  clearTimeout(conversation.idleTimer)
  setStatus(ctx, conversation, "running")
  try {
    const contextBlock =
      isRegularPrompt && ctx.config.readContextEachTurn
        ? await readTurnContext(ctx, { conversation, agent, generation })
        : undefined
    if (conversation.generation !== generation || conversation.process !== agent) return
    if (agent.cancelRequested) {
      emit(ctx, conversation, { type: "turn_end", stopReason: "cancelled" })
      return
    }

    // The agent only parses a native command from the first text block: the user's text stays first, the preamble
    // goes before it only on a regular prompt, and the context block after it (never recorded, never shown).
    const prompt = [{ type: "text" as const, text: message.text }]
    if (isRegularPrompt) {
      if (contextBlock !== undefined) prompt.push({ type: "text", text: contextBlock })
      if (!agent.preambleSent) {
        prompt.unshift({ type: "text", text: buildPreamble(message.session, provider.preambleAdditions?.()) })
        agent.preambleSent = true
      }
    }
    agent.promptInFlight = true
    const promptSentAt = Date.now()
    const response = await agent.connection.prompt({ sessionId: agent.sessionId, prompt })
    if (conversation.process === agent) emit(ctx, conversation, { type: "turn_end", stopReason: response.stopReason })
    console.info(
      `[turn] agent=${provider.id} stop=${response.stopReason} contextMs=${promptSentAt - agent.turnStartedAt} totalMs=${Date.now() - agent.turnStartedAt}`,
    )
  } catch (error) {
    if (conversation.process === agent) {
      flushHeldText(ctx, conversation)
      notify(ctx, conversation, "error", provider.describePromptError?.(error) ?? `Agent error: ${errorMessage(error)}`)
    }
  } finally {
    agent.turnActive = false
    agent.promptInFlight = false
    if (conversation.process === agent) {
      setStatus(ctx, conversation, "idle")
      scheduleSave(ctx, conversation)
      refreshIdleTimer(ctx, conversation)
    }
  }
}

export async function handleChatCancel(ctx: Context, windowId: string): Promise<void> {
  const conversation = ctx.windowConversations.get(windowId)
  const agent = conversation?.process
  if (conversation === undefined || agent === undefined) return
  cancelPendingPermissions(ctx, conversation, agent)
  if (agent.turnActive && !agent.promptInFlight) {
    agent.cancelRequested = true
    return
  }
  await agent.connection.cancel({ sessionId: agent.sessionId })
}
