// Minimal stand-in for codex-acp used by agentSessions tests: speaks newline-delimited JSON-RPC on stdio.
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const modeValues = ["read-only", "workspace-write", "agent", "agent-full-access"]

let mode = process.env.INITIAL_AGENT_MODE ?? "read-only"
let collaborationMode = "default"

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
    {
      id: "collaboration_mode",
      name: "Collaboration mode",
      category: "collaboration_mode",
      type: "select",
      currentValue: collaborationMode,
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
  ]
}

const commandNames = ["status", "mcp", "plan", "compact", "rename", "logout", "review", "review-branch", "review-commit", "goal", "$skill"]

function notify(update: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update } })}\n`)
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

interface Message {
  id?: unknown
  method?: string
  result?: { outcome?: { outcome?: string; optionId?: string } }
  params?: {
    configId?: string
    value?: string
    prompt?: Array<{ text: string }>
    mcpServers?: Array<{ headers: Array<{ name: string; value: string }> }>
  }
}

// How the current session was established and the window it is bound to, echoed back in replies so tests can see it.
let sessionKind = "new"
let windowHeader = ""
let heldPromptId: unknown
let permissionPromptId: unknown
let toolCounter = 0

function captureWindowHeader(message: Message): void {
  const headers = message.params?.mcpServers?.[0]?.headers ?? []
  windowHeader = headers.find((header) => header.name === "X-Prismic-Window-Id")?.value ?? ""
}

function publishCommands(): void {
  notify({
    sessionUpdate: "available_commands_update",
    availableCommands: commandNames.map((name) => ({ name, description: name, input: null })),
  })
}

function chunk(text: string): void {
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
}

function log(line: string): void {
  if (process.env.FAKE_AGENT_LOG !== undefined) appendFileSync(process.env.FAKE_AGENT_LOG, `${line}\n`)
}

// Simulates an agent that keeps talking after the bridge stopped it: it ignores SIGTERM, then sends text and a
// permission request, and logs how the bridge answered. It exits by itself shortly after.
function misbehave(): void {
  process.on("SIGTERM", () => {})
  setTimeout(() => process.exit(0), 3000).unref()
  setTimeout(() => {
    chunk("late-text")
    write({
      jsonrpc: "2.0",
      id: "perm-late",
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "late-tool", title: "Late tool" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    })
  }, 300)
}

function handlePrompt(message: Message): void {
  const blocks = message.params?.prompt ?? []
  const text = blocks.at(-1)?.text ?? ""
  if (text.includes("flood-permissions")) {
    heldPromptId = message.id
    for (let index = 0; index < 25; index++) {
      write({
        jsonrpc: "2.0",
        id: `perm-f-${index}`,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          toolCall: { toolCallId: `flood-${index}`, title: `Flood ${index}` },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      })
    }
    return
  }
  if (text.includes("late-output")) {
    misbehave()
    return
  }
  if (text.includes("hold")) {
    chunk("working")
    heldPromptId = message.id
    return
  }
  if (text.includes("ask-permission")) {
    permissionPromptId = message.id
    write({
      jsonrpc: "2.0",
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tool-1", title: "Run tool" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    })
    return
  }
  chunk(`ctx:${sessionKind}:${windowHeader}`)
  // "emit-tool <server>.<tool> <text>": an MCP tool call shaped like codex-acp's reports. Like codex-acp, the
  // completed update leaves out the title and rawInput because they are unchanged since the start report.
  if (text.startsWith("emit-tool ")) {
    const [, identity = "", ...rest] = text.split(" ")
    const [server = "", tool = ""] = identity.split(".")
    const output = rest.join(" ")
    const toolCallId = `mcp-${toolCounter++}`
    notify({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `mcp.${server}.${tool}`,
      status: "in_progress",
      rawInput: { server, tool, arguments: {} },
    })
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: output }], structuredContent: null }, error: null },
    })
    respond(message.id, { stopReason: "end_turn" })
    return
  }
  if (text.includes("use-tool")) {
    notify({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tool", status: "in_progress" })
    notify({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" })
  }
  for (const block of blocks) chunk(`prompt:${block.text}`)
  respond(message.id, { stopReason: "end_turn" })
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as Message
  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      })
      break
    case "session/new":
      sessionKind = "new"
      captureWindowHeader(message)
      publishCommands()
      respond(message.id, { sessionId: "fake-session", configOptions: configOptions() })
      break
    case "session/load":
      sessionKind = "load"
      captureWindowHeader(message)
      publishCommands()
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-history" } })
      respond(message.id, { configOptions: configOptions() })
      break
    case "session/set_config_option":
      if (message.params?.configId === "mode" && message.params.value !== undefined) mode = message.params.value
      if (message.params?.configId === "collaboration_mode" && message.params.value !== undefined) {
        collaborationMode = message.params.value
      }
      respond(message.id, { configOptions: configOptions() })
      break
    case "session/prompt":
      handlePrompt(message)
      break
    case "session/cancel":
      if (heldPromptId !== undefined) respond(heldPromptId, { stopReason: "cancelled" })
      heldPromptId = undefined
      break
    default:
      if (message.method === undefined && typeof message.id === "string" && message.id.startsWith("perm-f-")) {
        log(`flood:${message.result?.outcome?.outcome}`)
      } else if (message.method === undefined && message.id === "perm-late") {
        log(`late-permission:${message.result?.outcome?.outcome}`)
        process.exit(0)
      } else if (message.method === undefined && message.id === "perm-1") {
        const outcome = message.result?.outcome
        chunk(`permission:${outcome?.outcome === "selected" ? outcome.optionId : outcome?.outcome}`)
        respond(permissionPromptId, { stopReason: "end_turn" })
        permissionPromptId = undefined
      } else if (message.id !== undefined && message.method !== undefined) {
        respond(message.id, {})
      }
  }
}
