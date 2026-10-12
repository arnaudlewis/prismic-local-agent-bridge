import type { SessionConfigOption, SessionConfigSelectOptions } from "@agentclientprotocol/sdk"

import { errorMessage } from "../errors.ts"
import type { BridgeConfigOption, ClientMessage } from "../protocol.ts"
import type { Context } from "./context.ts"
import { notify, sendLive, sendToWindow } from "./output.ts"
import type { AgentFields, Conversation } from "./types.ts"

function flattenSelectValues(options: SessionConfigSelectOptions): BridgeConfigOption["values"] {
  const values: BridgeConfigOption["values"] = []
  for (const entry of options) {
    const choices = "group" in entry ? entry.options : [entry]
    for (const choice of choices) {
      values.push({ value: choice.value, name: choice.name, description: choice.description ?? undefined })
    }
  }
  return values
}

// Only select options are relayed; boolean ones are ignored and groups are flattened.
function toBridgeConfigOptions(options: SessionConfigOption[]): BridgeConfigOption[] {
  const result: BridgeConfigOption[] = []
  for (const option of options) {
    if (option.type !== "select") continue
    result.push({
      id: option.id,
      name: option.name,
      category: option.category ?? undefined,
      currentValue: option.currentValue,
      values: flattenSelectValues(option.options),
    })
  }
  return result
}

export function sendSessionConfig(ctx: Context, conversation: Conversation, agent: AgentFields): void {
  sendLive(ctx, conversation, { type: "session_config", options: toBridgeConfigOptions(agent.configOptions) })
}

export function sendAvailableCommands(ctx: Context, conversation: Conversation, agent: AgentFields): void {
  if (agent.availableCommands.length === 0) return
  sendLive(ctx, conversation, { type: "available_commands", commands: agent.availableCommands })
}

export function sendAgentState(ctx: Context, conversation: Conversation, agent: AgentFields): void {
  sendSessionConfig(ctx, conversation, agent)
  sendAvailableCommands(ctx, conversation, agent)
}

// The mode is a security setting: a page must not be able to change it just by opening the chat.
export function withoutProtectedConfig(
  preferred: Record<string, string>,
  protectedIds: readonly string[],
): Record<string, string> {
  return Object.fromEntries(Object.entries(preferred).filter(([id]) => !protectedIds.includes(id)))
}

function offersValue(options: SessionConfigOption[], configId: string, value: string): boolean {
  const option = options.find((candidate) => candidate.id === configId)
  if (option === undefined || option.type !== "select") return false
  return flattenSelectValues(option.options).some((candidate) => candidate.value === value)
}

// The provider's starting config for a new session. Unlike the user's own choices, a failure here is fatal: the
// agent must not run in a mode other than the one the bridge decided on.
export async function applyInitialConfig(initial: Record<string, string>, agent: AgentFields): Promise<void> {
  for (const [configId, value] of Object.entries(initial)) {
    const option = agent.configOptions.find((candidate) => candidate.id === configId)
    if (option?.type === "select" && option.currentValue === value) continue
    if (!offersValue(agent.configOptions, configId, value)) {
      throw new Error(`The agent doesn't offer ${configId} = ${value}`)
    }
    const response = await agent.connection.setSessionConfigOption({ sessionId: agent.sessionId, configId, value })
    agent.configOptions = response.configOptions
  }
}

// Re-applies the conversation's choices to a fresh agent, the model first: effort values depend on it.
export async function applySelectedConfig(conversation: Conversation, agent: AgentFields): Promise<void> {
  const entries = Object.entries(conversation.selectedConfig).sort(
    ([a], [b]) => Number(b === "model") - Number(a === "model"),
  )
  for (const [configId, value] of entries) {
    if (conversation.process !== agent) return
    if (!offersValue(agent.configOptions, configId, value)) continue
    try {
      const response = await agent.connection.setSessionConfigOption({
        sessionId: agent.sessionId,
        configId,
        value,
      })
      if (conversation.process !== agent) return
      agent.configOptions = response.configOptions
    } catch (error) {
      console.warn(`Could not restore ${configId}: ${errorMessage(error)}`)
    }
  }
}

export async function handleSetConfigOption(
  ctx: Context,
  windowId: string,
  message: Extract<ClientMessage, { type: "set_config_option" }>,
): Promise<void> {
  const conversation = ctx.windowConversations.get(windowId)
  const agent = conversation?.process
  if (conversation === undefined || agent === undefined) {
    sendToWindow(ctx, windowId, { type: "notice", tone: "info", text: "The local agent isn't running yet." })
    return
  }
  if (agent.turnActive) {
    notify(ctx, conversation, "info", "Wait for the current reply to finish before changing the model or effort.")
    return
  }
  const { configId, value } = message
  // A delete or restart during the RPC makes its answer stale: it must not leak into another chat.
  const generation = conversation.generation
  const isStale = () => conversation.generation !== generation || conversation.process !== agent
  try {
    const response = await agent.connection.setSessionConfigOption({
      sessionId: agent.sessionId,
      configId,
      value,
    })
    if (isStale()) return
    conversation.selectedConfig[configId] = value
    agent.configOptions = response.configOptions
  } catch (error) {
    if (isStale()) return
    const optionName = agent.configOptions.find((option) => option.id === configId)?.name ?? configId
    notify(ctx, conversation, "error", `Couldn't change ${optionName}: ${errorMessage(error)}`)
  }
  sendSessionConfig(ctx, conversation, agent)
}
