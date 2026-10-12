import type { AvailableCommand } from "@agentclientprotocol/sdk"

import type { AgentProvider } from "../agents/provider.ts"
import type { BridgeCommand } from "../protocol.ts"

export function toBridgeCommand(command: AvailableCommand): BridgeCommand {
  const hint = command.input?.hint
  return { name: command.name, description: command.description, ...(hint === undefined ? {} : { hint }) }
}

// What the browser is offered: not the blocked commands, nor those it has a dedicated control for.
export function offeredCommands(provider: AgentProvider, commands: AvailableCommand[]): BridgeCommand[] {
  return commands
    .map(toBridgeCommand)
    .filter((command) => !provider.blockedCommands.includes(command.name.toLowerCase()))
    .filter((command) => !provider.hiddenCommands.includes(command.name.toLowerCase()))
}

// The name of a blocked native command the prompt would run, so that it is not forwarded.
export function blockedCommandName(provider: AgentProvider, text: string): string | undefined {
  const name = provider.nativeCommandName(text)
  return name !== undefined && provider.blockedCommands.includes(name) ? name : undefined
}

// Native commands run inside the agent and never reach the model: no editor context, no preamble.
export function isNativeCommand(provider: AgentProvider, text: string): boolean {
  return provider.nativeCommandName(text) !== undefined
}

export function blockedCommandNotice(name: string): string {
  return `The /${name} command isn't available in the local agent.`
}
