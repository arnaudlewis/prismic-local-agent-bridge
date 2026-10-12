export const agentModes = ["read-only", "workspace-write", "agent", "agent-full-access"] as const

export type AgentMode = (typeof agentModes)[number]
