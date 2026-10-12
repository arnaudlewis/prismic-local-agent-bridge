// Minimal stand-in for codex-acp used by agentSessions tests: speaks newline-delimited JSON-RPC on stdio.
import { createInterface } from "node:readline"

const modeValues = ["read-only", "workspace-write", "agent", "agent-full-access"]

let mode = process.env.INITIAL_AGENT_MODE ?? "read-only"

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: modeValues.map((value) => ({ value, name: value })),
    },
  ]
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { configId?: string; value?: string } }
  switch (message.method) {
    case "initialize":
      respond(message.id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } })
      break
    case "session/new":
      respond(message.id, { sessionId: "fake-session", configOptions: configOptions() })
      break
    case "session/set_config_option":
      if (message.params?.configId === "mode" && message.params.value !== undefined) mode = message.params.value
      respond(message.id, { configOptions: configOptions() })
      break
    default:
      if (message.id !== undefined) respond(message.id, {})
  }
}
